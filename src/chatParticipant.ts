import * as path from "path";
import * as vscode from "vscode";
import { ResolvedCli, buildSpawnArgs, runDsh, normalizeExtraArgs } from "./cli";
import { SessionTracer } from "./sessionTracer";
import { writeModelPatch, loadSelection } from "./modelSelection";
import { stableHash } from "./sessionStore";
import { ProjectMemory } from "./memory";
import { PluginWatch } from "./pluginWatch";
import { isAnyTaskActive, setTaskActive } from "./taskGuard";
import { resolveAgentModePatch } from "./agentModes";
import { isZh, t, tf } from "./i18n";

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
  // 老版本 VS Code 可能没有 chat API / 未声明 participant 会抛错：
  // 注册失败只影响 @dsh-agent，绝不能中断整个扩展激活（其余命令/侧边栏照常可用）。
  if (!vscode.chat?.createChatParticipant) {
    log?.(t("当前 VS Code 版本不支持 Chat Participant，已跳过 @dsh-agent 注册。", "Chat Participant is not supported by this VS Code version; skipped @dsh-agent registration."));
    return new vscode.Disposable(() => {});
  }
  try {
    return registerParticipant(context, cliProvider, envProvider, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log?.(tf(t("@dsh-agent 注册失败（其余功能不受影响）：{0}", "@dsh-agent registration failed (other features remain available): {0}"), message));
    return new vscode.Disposable(() => {});
  }
}

/** 实际注册 @dsh-agent 的实现（已声明在 package.json contributes.chatParticipants）。 */
function registerParticipant(
  context: vscode.ExtensionContext,
  cliProvider: () => Promise<ResolvedCli>,
  envProvider: () => Promise<NodeJS.ProcessEnv>,
  log?: (line: string) => void
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant("dsh-agent", async (request, _chatCtx, stream, token) => {
    if (isAnyTaskActive()) {
      stream.markdown(
        t(
          "已有 DSH 任务正在运行（聊天面板或另一个 @dsh-agent），请等待完成或先取消。",
          "A DSH task is already running (chat panel or another @dsh-agent). Wait for it or cancel it first."
        )
      );
      return { metadata: {} };
    }
    setTaskActive("participant", true);
    try {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      stream.markdown(t("请先打开一个项目文件夹，再使用 DSH。", "Open a project folder first, then use DSH."));
      return { metadata: {} };
    }
    const prompt = request.prompt.trim();
    if (!prompt) {
      stream.markdown(t("请输入要交给 DSH 的任务，例如：`@dsh-agent 总结一下这个项目的结构`。", "Enter a task for DSH, e.g. `@dsh-agent summarize this project's structure`."));
      return { metadata: {} };
    }

    stream.progress(t("正在运行 DSH…", "Running DSH…"));

    const refText = await collectReferences(request.references);
    const memory = new ProjectMemory(folder.uri.fsPath);
    const taskText = buildChatTaskText(folder.uri.fsPath, prompt, refText, memory.excerpt(), isZh());

    let cli: ResolvedCli;
    try {
      cli = await cliProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stream.markdown(tf(t("无法解析 dsh 命令：{0}", "Cannot resolve dsh command: {0}"), message));
      return { metadata: {} };
    }

    const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
    const extraArgs = normalizeExtraArgs(cfg.get("extraArgs", []));
    const rawTimeout = cfg.get<number>("timeoutSeconds", 600);
    const timeoutSec = Number.isFinite(rawTimeout) ? Math.min(7200, Math.max(30, rawTimeout)) : 600;
    const rawStream = cfg.get<unknown>("streamProgress", true);
    const streamProgress = typeof rawStream === "boolean" ? rawStream : rawStream !== "false";

    if (streamProgress) {
      extraArgs.push("--patch", path.join(context.extensionPath, "patch", "stream.patch.yml"));
    }
    const folderHash = stableHash(folder.uri.fsPath);
    const selection = loadSelection(context.globalStorageUri.fsPath, folderHash);
    let modelPatch: string | undefined;
    try {
      modelPatch = selection ? writeModelPatch(context.globalStorageUri.fsPath, folderHash, selection) : undefined;
    } catch {
      // 模型补丁写失败不影响 @dsh-agent 任务本身
      modelPatch = undefined;
    }
    if (modelPatch) extraArgs.push("--patch", modelPatch);
    if (selection?.mode) {
      const modeRes = resolveAgentModePatch(cli, selection.mode);
      if (modeRes.patch) extraArgs.push("--patch", modeRes.patch);
      else log?.(`@dsh-agent mode patch unavailable: ${modeRes.error}`);
    }

    const args = buildSpawnArgs(cli, extraArgs, taskText);
    const env = await envProvider();

    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());

    let tracer: SessionTracer | undefined;
    let tracerDone: Promise<void> = Promise.resolve();
    if (streamProgress) {
      tracer = new SessionTracer(env, Date.now(), log);
      tracerDone = tracer.start((msg) => {
        if (msg.kind === "tool") stream.progress(tf(t("执行工具：{0}", "Running tool: {0}"), msg.name));
        else if (msg.kind === "turn" && msg.turn > 0) stream.progress(tf(t("第 {0} 轮", "Round {0}"), msg.turn));
      }, abort.signal);
    }

    try {
      const result = await runDsh(cli, args, {
        cwd: folder.uri.fsPath,
        timeoutMs: timeoutSec * 1000,
        env,
        signal: abort.signal,
      });

      // @dsh-agent 任务里 agent 也可能直接安装插件：与聊天面板任务一样补一次哨兵检测
      void new PluginWatch(context).checkOnce(cli).catch(() => {});

      if (token.isCancellationRequested) {
        stream.markdown(t("已取消。", "Cancelled."));
        return { metadata: {} };
      }
      if (result.timedOut) {
        stream.markdown(tf(t("任务超时（超过 {0} 秒）已被取消。可在设置 dsh-harness-vscode.timeoutSeconds 中调整。", "Task timed out after {0}s and was cancelled. Adjust dsh-harness-vscode.timeoutSeconds in settings."), timeoutSec));
        return { metadata: {} };
      }
      if (result.code !== 0) {
        const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        if (/MISSING_CREDENTIAL|no API key/i.test(detail)) {
          stream.markdown(
            t(
              `检测到未配置 API Key。请执行「DSH: 配置 API Key」输入 DeepSeek API Key（sk-...），或在系统环境变量中设置 DEEPSEEK_API_KEY。\n\n原始错误：\n${detail}`,
              `No API key configured. Run "DSH: Set API Key" to enter your DeepSeek API key (sk-...), or set DEEPSEEK_API_KEY in your environment.\n\nRaw error:\n${detail}`
            )
          );
          return { metadata: {} };
        }
        stream.markdown(tf(t("DSH 任务失败（exit {0}）：\n\n```\n{1}\n```", "DSH task failed (exit {0}):\n\n```\n{1}\n```"), result.code ?? "?", detail));
        return { metadata: {} };
      }
      stream.markdown(result.stdout.trim() || t("（DSH 未返回文本输出）", "(DSH returned no text output)"));
      return { metadata: {} };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stream.markdown(tf(t("运行 DSH 失败：{0}", "Failed to run DSH: {0}"), message));
      return { metadata: {} };
    } finally {
      // 无论成功/异常/取消都结束 tracer 并等待排空，避免后台轮询泄漏
      tracer?.finish();
      await tracerDone;
      sub.dispose();
    }
    } finally {
      setTaskActive("participant", false);
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
        const clipped = content.length > 40000 ? content.slice(0, 40000) + t("\n…(文件过大，已截断)", "\n…(file too large, truncated)") : content;
        parts.push(`@${value.fsPath}\n${clipped}`);
      } catch {
        parts.push(`@${value.fsPath}\n${t("（无法读取）", "(unreadable)")}`);
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
