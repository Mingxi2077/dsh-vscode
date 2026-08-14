import * as path from "path";
import * as vscode from "vscode";
import { ResolvedCli, buildSpawnArgs, runDsh } from "./cli";
import { SessionTracer } from "./sessionTracer";
import { writeModelPatch, loadSelection } from "./modelSelection";
import { stableHash } from "./sessionStore";
import { ProjectMemory } from "./memory";
import { isZh } from "./i18n";

/**
 * 注册 @dsh-agent 聊天参与者：在 VS Code 内置 Chat 里 @dsh-agent <任务> 即可唤起，
 * 复用 headless 驱动 + 流式进度，回答以 markdown 吐回聊天流。
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  cliProvider: () => Promise<ResolvedCli>,
  envProvider: () => Promise<NodeJS.ProcessEnv>,
  log?: (line: string) => void
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant("dsh-agent", async (request, _chatCtx, stream, token) => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown("请先打开一个项目文件夹，再使用 DSH。");
      return { metadata: {} };
    }
    const prompt = request.prompt.trim();
    if (!prompt) {
      stream.markdown("请输入要交给 DSH 的任务，例如：`@dsh-agent 总结一下这个项目的结构`。");
      return { metadata: {} };
    }

    stream.progress("正在运行 DSH…");

    const refText = await collectReferences(request.references);
    const memory = new ProjectMemory(folder.uri.fsPath);
    const taskText = buildChatTaskText(folder.uri.fsPath, prompt, refText, memory.excerpt(), isZh());

    let cli: ResolvedCli;
    try {
      cli = await cliProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stream.markdown(`无法解析 dsh 命令：${message}`);
      return { metadata: {} };
    }

    const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
    const extraArgs = cfg.get<string[]>("extraArgs", []);
    const timeoutSec = cfg.get<number>("timeoutSeconds", 600);
    const streamProgress = cfg.get<boolean>("streamProgress", true);

    if (streamProgress) {
      extraArgs.push("--patch", path.join(context.extensionPath, "patch", "stream.patch.yml"));
    }
    const folderHash = stableHash(folder.uri.fsPath);
    const selection = loadSelection(context.globalStorageUri.fsPath, folderHash);
    const modelPatch = selection ? writeModelPatch(context.globalStorageUri.fsPath, folderHash, selection) : undefined;
    if (modelPatch) extraArgs.push("--patch", modelPatch);

    const args = buildSpawnArgs(cli, extraArgs, taskText);
    const env = await envProvider();

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());

    let tracer: SessionTracer | undefined;
    if (streamProgress) {
      tracer = new SessionTracer(env, Date.now(), log);
      void tracer.start((msg) => {
        if (msg.kind === "tool") stream.progress(`执行工具：${msg.name}`);
        else if (msg.kind === "turn" && msg.turn > 0) stream.progress(`第 ${msg.turn} 轮`);
      }, abort.signal);
    }

    try {
      const result = await runDsh(cli, args, {
        cwd: folder.uri.fsPath,
        timeoutMs: timeoutSec * 1000,
        env,
        signal: abort.signal,
      });
      tracer?.finish();

      if (token.isCancellationRequested) {
        stream.markdown("已取消。");
        return { metadata: {} };
      }
      if (result.timedOut) {
        stream.markdown(`任务超时（超过 ${timeoutSec} 秒）已被取消。可在设置 dsh-harness-vscode.timeoutSeconds 中调整。`);
        return { metadata: {} };
      }
      if (result.code !== 0) {
        const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        stream.markdown(`DSH 任务失败（exit ${result.code ?? "?"}）：\n\n\`\`\`\n${detail}\n\`\`\``);
        return { metadata: {} };
      }
      stream.markdown(result.stdout.trim() || "（DSH 未返回文本输出）");
      return { metadata: {} };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stream.markdown(`运行 DSH 失败：${message}`);
      return { metadata: {} };
    } finally {
      sub.dispose();
    }
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  return participant;
}

async function collectReferences(
  refs: readonly vscode.ChatPromptReference[]
): Promise<string> {
  const parts: string[] = [];
  for (const ref of refs) {
    const value = ref.value;
    if (value instanceof vscode.Uri) {
      try {
        const buf = await vscode.workspace.fs.readFile(value);
        const content = Buffer.from(buf).toString("utf8");
        const clipped = content.length > 40000 ? content.slice(0, 40000) + "\n…(文件过大，已截断)" : content;
        parts.push(`@${value.fsPath}\n${clipped}`);
      } catch {
        parts.push(`@${value.fsPath}\n（无法读取）`);
      }
    } else if (typeof value === "string" && value.trim()) {
      parts.push(value.slice(0, 2000));
    }
  }
  return parts.join("\n\n");
}

function buildChatTaskText(
  folderPath: string,
  prompt: string,
  refText: string,
  memoryText: string,
  zh = true
): string {
  const lines: string[] = [
    zh
      ? "你在 VS Code 的 Copilot Chat 中通过 @dsh-agent 辅助用户完成项目任务。"
      : "You are helping the user with a project task in VS Code's Copilot Chat via @dsh-agent.",
    zh ? `项目根目录：${folderPath}` : `Project root: ${folderPath}`,
    zh ? "请直接回应这个任务，不要复述或客套。" : "Respond directly to this task; do not restate or be polite.",
  ];
  if (memoryText) {
    lines.push("", zh ? "--- 项目长期记忆（按需参考）---" : "--- Project long-term memory (reference as needed) ---", memoryText);
  }
  if (refText) {
    lines.push("", zh ? "用户引用了以下文件/内容，按需参考：" : "The user referenced the following files/content; reference as needed:", refText);
  }
  lines.push("", zh ? "--- 任务 ---" : "--- Task ---", prompt);
  return lines.join("\n");
}
