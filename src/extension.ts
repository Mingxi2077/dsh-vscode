import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import { ChatPanel, StatusBar } from "./chatPanel";
import { resolveCli, ResolvedCli, runCliVersion, buildSpawnArgs, runDsh } from "./cli";
import { SecretStore } from "./secrets";
import { writeModelPatch, readCustomProviders, catalogProviderById } from "./modelSelection";
import { settingsPath } from "./settingsEditor";
import { stableHash } from "./sessionStore";
import { registerChatParticipant } from "./chatParticipant";
import { registerSidebarView } from "./sidebar";
import { openPluginCenter, pluginStatusSummary } from "./pluginCenter";
import { openPresetCenter, presetStatusSummary } from "./presetCenter";
import { PluginWatch } from "./pluginWatch";
import { t, tf } from "./i18n";

/** 检查 llm-pi-ai.providers 配置的可服务性（返回多行说明）。 */
function checkProviderConfig(): string[] {
  const providers = readCustomProviders();
  if (providers.length === 0) return [t("未配置任何自定义/第三方提供商（内置 DeepSeek 官方可用）。", "No custom/third-party providers configured (built-in DeepSeek official is available).")];
  const lines = providers.map((p) => {
    const cat = catalogProviderById(p.id);
    const kind = cat ? t("DSH 内置（catalog）", "DSH built-in (catalog)") : t("自定义", "custom");
    const hasKey = p.apiKeyEnv ? `${p.apiKeyEnv}${t("（运行时注入）", " (injected at runtime)")}` : t("未声明 apiKeyEnv", "no apiKeyEnv");
    return `${p.displayName || p.id} (${p.id}) · ${kind} · Key: ${hasKey}`;
  });
  lines.push(tf(t("共 {0} 个提供商。模型由 DSH 目录提供，升级后自动跟随。", "{0} providers total. Models come from the DSH catalog and auto-follow upgrades."), providers.length));
  return lines;
}

/** 子进程环境变量提供者：进程环境 + 系统密钥链中的 API Key + 用户配置覆盖。 */
function createEnvProvider(secrets: SecretStore): () => Promise<NodeJS.ProcessEnv> {
  return async () => {
    const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
    const extraEnv = cfg.get<Record<string, string>>("environment", {});
    const permissionMode = cfg.get<string>("permissionMode", "workspace-write");
    const env: NodeJS.ProcessEnv = { ...process.env };
    // 注入所有用户通过扩展保存的 API Key（环境里已有的以环境为准）
    const stored = await secrets.envSecrets();
    for (const [name, value] of Object.entries(stored)) {
      if (!env[name]) env[name] = value;
    }
    // 用户显式配置的 environment 优先级最高
    const final: NodeJS.ProcessEnv = { ...env, ...extraEnv };
    // 沙箱权限模式：默认 workspace-write；用户若在 environment 里显式给了 DSH_PERMISSION_MODE 则以它为准
    if (!extraEnv.DSH_PERMISSION_MODE) {
      final.DSH_PERMISSION_MODE = permissionMode;
    }
    return final;
  };
}

/** 检测 DEEPSEEK_API_KEY 是否可用（不打印内容）。 */
async function apiKeyStatus(secrets: SecretStore): Promise<string> {
  const secret = await secrets.get("DEEPSEEK_API_KEY");
  if (secret) return t("已配置（系统密钥链）", "configured (system keychain)");
  if (process.env.DEEPSEEK_API_KEY) return t("已配置（环境变量 DEEPSEEK_API_KEY）", "configured (env DEEPSEEK_API_KEY)");
  const credFile = path.join(os.homedir(), ".dsh", ".credentials.yaml");
  try {
    const raw = fs.readFileSync(credFile, "utf8");
    if (/DEEPSEEK_API_KEY\s*:/.test(raw)) return t("已配置（~/.dsh/.credentials.yaml）", "configured (~/.dsh/.credentials.yaml)");
  } catch {
    // 文件不存在或不可读，按未配置处理
  }
  return t("未配置 → 请运行「DSH: 配置 API Key」", "not set → run \"DSH: Set API Key\"");
}

/** 状态栏控制器：运行中指示 + 就绪状态。 */
class StatusBarController implements StatusBar {
  private readonly item: vscode.StatusBarItem;
  private running = false;
  private ready = true;
  private message = "DSH: 打开对话面板";

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "dsh-harness-vscode.openChat";
    this.item.show();
    this.update();
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.update();
  }

  setReady(ok: boolean, message: string): void {
    this.ready = ok;
    this.message = message;
    this.update();
  }

  private update(): void {
    this.item.text = this.running
      ? "$(sync~spin) DSH 运行中"
      : "$(comment-discussion) DSH";
    this.item.tooltip = this.message;
    this.item.color = this.ready ? undefined : new vscode.ThemeColor("errorForeground");
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** 带缓存的 CLI 解析器；配置变更时失效。 */
function createCliProvider(): () => Promise<ResolvedCli> {
  let cache: Promise<ResolvedCli> | undefined;

  const provider = async (): Promise<ResolvedCli> => {
    if (!cache) {
      const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
      cache = resolveCli(cfg.get<string>("cliPath", "")).catch((err) => {
        cache = undefined;
        throw err;
      });
    }
    return cache;
  };

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("dsh-harness-vscode.cliPath")) {
      cache = undefined;
    }
  });

  return provider;
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage(
      t("请先通过「文件 → 打开文件夹」打开一个项目，再使用 DSH。", "Open a project folder first (File → Open Folder), then use DSH.")
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      description: f.uri.fsPath,
      folder: f,
    })),
    { placeHolder: t("选择 DSH 工作目录", "Choose the DSH working directory") }
  );
  return pick?.folder;
}

function relPath(folder: vscode.WorkspaceFolder, absPath: string): string {
  const rel = path.relative(folder.uri.fsPath, absPath);
  return rel.startsWith("..") ? absPath : rel;
}

/** 递归列出目录下所有文件路径（用于自检扫描会话日志）。 */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/** 运行 git diff 获取当前改动摘要（用于审查类快捷命令）。 */
function gitDiffSummary(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", "diff", "--stat", "-M"],
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      (err, stdout) => {
        resolve(err ? "" : stdout.trim());
      }
    );
  });
}

/** 打开（或复用）聊天面板并预填输入框。 */
async function openChatWithDraft(
  context: vscode.ExtensionContext,
  cliProvider: () => Promise<ResolvedCli>,
  envProvider: () => Promise<NodeJS.ProcessEnv>,
  secrets: SecretStore,
  status: StatusBar,
  log: (line: string) => void,
  draft: string
): Promise<ChatPanel | undefined> {
  const folder = await pickFolder();
  if (!folder) return undefined;
  const chat = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
  chat.setDraft(draft);
  return chat;
}

export function activate(context: vscode.ExtensionContext): void {
  const status = new StatusBarController();
  context.subscriptions.push(status);

  const output = vscode.window.createOutputChannel("DSH");
  context.subscriptions.push(output);
  const log = (line: string) => output.appendLine(line);

  const secrets = new SecretStore(
    context.secrets,
    path.join(context.globalStorageUri.fsPath, "secret-index.json")
  );
  const cliProvider = createCliProvider();
  const envProvider = createEnvProvider(secrets);
  let panel: ChatPanel | undefined;

  // 插件"哨兵"：发现 profile 里未检测过的新插件（无论谁安装）自动补兼容性检测
  const pluginWatch = new PluginWatch(context);

  // @dsh-agent 聊天参与者（内置 Chat 中 @ 唤起）
  context.subscriptions.push(registerChatParticipant(context, cliProvider, envProvider, log));

  // 活动栏侧边栏状态视图
  context.subscriptions.push(registerSidebarView(context));

  context.subscriptions.push(
    // 插件中心：浏览已装插件（只读视图）；打开前先补一次新插件检测
    vscode.commands.registerCommand("dsh-harness-vscode.pluginCenter", async () => {
      try {
        await pluginWatch.checkOnce(await cliProvider());
      } catch {
        // 检测失败不阻塞插件中心
      }
      void openPluginCenter(cliProvider);
    }),

    // 模式预设：启用/停用 DSH 原生行为预设
    vscode.commands.registerCommand("dsh-harness-vscode.presetCenter", () => {
      void openPresetCenter();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.openChat", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      panel = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
      status.setReady(true, "DSH: " + t("打开对话面板", "Open Chat panel"));
    }),

    // 配置 API Key：普通用户第一步，保存在系统密钥链（VS Code SecretStorage）
    vscode.commands.registerCommand("dsh-harness-vscode.configureApiKey", async () => {
      const hasSecret = !!(await secrets.get("DEEPSEEK_API_KEY"));
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: t("设置 DeepSeek API Key", "Set DeepSeek API Key"),
            description: t("保存在系统密钥链中，不写入任何配置文件", "Stored in the system keychain, never written to any config file"),
          },
          {
            label: t("清除已保存的 API Key", "Clear saved API Key"),
            description: hasSecret ? t("当前已配置", "currently set") : t("当前未配置", "not set"),
          },
        ],
        { placeHolder: "DSH API Key" }
      );
      if (!pick) return;

      if (pick.label.startsWith(t("设置", "Set"))) {
        const key = await vscode.window.showInputBox({
          prompt: t("输入 DeepSeek API Key（sk- 开头，在 platform.deepseek.com 申请）", "Enter your DeepSeek API Key (starts with sk-, get one at platform.deepseek.com)"),
          password: true,
          ignoreFocusOut: true,
          placeHolder: "sk-...",
          validateInput: (v) => (v && v.trim().length > 0 ? undefined : t("API Key 不能为空", "API key cannot be empty")),
        });
        if (key) {
          await secrets.set("DEEPSEEK_API_KEY", key.trim());
          status.setReady(true, "DSH API Key " + t("已配置", "set"));
          void vscode.window.showInformationMessage(
            t("API Key 已保存到系统密钥链。现在可以「DSH: 打开对话」开始使用了。", "API key saved to the system keychain. You can now run \"DSH: Open Chat\" to start.")
          );
        }
      } else {
        await secrets.delete("DEEPSEEK_API_KEY");
        status.setReady(hasSecret, hasSecret ? "DSH: API Key " + t("已清除", "cleared") : "DSH: API Key " + t("尚未配置", "not set"));
        void vscode.window.showInformationMessage(t("已清除 API Key。", "API key cleared."));
      }
    }),

    // 环境自检：普通用户装完第一步就运行它
    vscode.commands.registerCommand("dsh-harness-vscode.checkEnvironment", async () => {
      output.clear();
      output.appendLine(t("DSH 环境检查", "DSH Environment Check"));
      output.appendLine("==============");
      try {
        const cli = await cliProvider();
        output.appendLine(t("dsh 定位: {0}", "dsh location: {0}").replace("{0}", cli.source));
        output.appendLine(cli.kind === "entry" ? t("入口文件: {0}", "entry file: {0}").replace("{0}", cli.entry) : t("可执行文件: {0}", "executable: {0}").replace("{0}", cli.command));
        const version = await runCliVersion(cli);
        output.appendLine(t("版本: {0}", "version: {0}").replace("{0}", version || t("未知", "unknown")));
        const key = await apiKeyStatus(secrets);
        output.appendLine(`API Key: ${key}`);
        const permMode = vscode.workspace.getConfiguration("dsh-harness-vscode").get<string>("permissionMode", "workspace-write");
        output.appendLine(t("沙箱模式: {0}（无交互 headless 下审批失败关闭，无法自我越权）", "sandbox: {0} (headless has no interactive answerer, so approvals fail closed)").replace("{0}", permMode));
        if (permMode === "danger-full-access") {
          void vscode.window.showWarningMessage(t("⚠ 沙箱模式为 danger-full-access：dsh 将不受限操作且审批自动放行，请确保任务可信。", "⚠ Sandbox is danger-full-access: dsh operates unrestricted with auto-approval. Only if you fully trust the task."));
        }
        output.appendLine("");
        output.appendLine(t("Provider 配置检查：", "Provider config check:"));
        output.appendLine(`  settings.yaml: ${settingsPath()}`);
        const providerCheck = checkProviderConfig();
        for (const line of providerCheck) output.appendLine(`  ${line}`);
        output.appendLine("");
        output.appendLine(t("headless 插件：", "headless plugins:"));
        for (const line of pluginStatusSummary()) output.appendLine(`  ${line}`);
        output.appendLine("");
        output.appendLine(t("模式预设：", "mode presets:"));
        for (const line of presetStatusSummary()) output.appendLine(`  ${line}`);
        output.appendLine("");
        output.appendLine(t("检查通过。打开项目后执行「DSH: 打开对话」即可开始。", "Check passed. Open a project and run \"DSH: Open Chat\" to start."));
        output.show(true);
        status.setReady(true, `DSH ${version} ` + t("已就绪", "ready"));
        void vscode.window.showInformationMessage(`DSH ${version} ` + t("已就绪", "ready") + ` (API Key ${key.startsWith(t("已配置", "configured")) ? "✓" : "✗"})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(t("检查失败: {0}", "Check failed: {0}").replace("{0}", message));
        output.appendLine("");
        output.appendLine(t("请确认：", "Please confirm:"));
        output.appendLine("  1. " + t("已全局安装 dsh：npm i -g @deepseek-ai/dsh", "dsh installed globally: npm i -g @deepseek-ai/dsh"));
        output.appendLine("  2. " + t("dsh 在 PATH 中（新开一个终端执行 dsh --version 验证）", "dsh on PATH (open a new terminal and run dsh --version)"));
        output.appendLine("  3. " + t("或在本扩展设置 dsh-harness-vscode.cliPath 中指定 dsh 路径", "or set the dsh path in the dsh-harness-vscode.cliPath setting"));
        output.show(true);
        status.setReady(false, "DSH: " + t("环境异常，运行「DSH: 检查环境」查看详情", "environment issue — run \"DSH: Check Environment\" for details"));
        void vscode.window.showErrorMessage(t("DSH 环境检查失败：{0}", "DSH environment check failed: {0}").replace("{0}", message));
      }
    }),

    // 兼容性自检：跑一次 tiny 任务，验证流式补丁（明文会话日志）与模型补丁机制
    vscode.commands.registerCommand("dsh-harness-vscode.selfTest", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      output.clear();
      output.appendLine(t("DSH 兼容性自检", "DSH Compatibility Self-Test"));
      output.appendLine("================");
      void vscode.window.showInformationMessage(t("DSH 兼容性自检进行中…（约 10-20 秒）", "DSH compatibility self-test running… (10-20s)"));
      try {
        const cli = await cliProvider();
        const env = await envProvider();
        const streamPatch = path.join(context.extensionPath, "patch", "stream.patch.yml");
        const sessionsDir = path.join(env.DSH_HOME || path.join(os.homedir(), ".dsh"), "sessions-vscode");
        const before = new Set(walkFiles(sessionsDir).filter((f) => f.endsWith("session.jsonl")));

        const extraArgs = ["--patch", streamPatch];
        const sel = panel ? panel.selection : undefined;
        const modelPatch = sel ? writeModelPatch(context.globalStorageUri.fsPath, stableHash(folder.uri.fsPath), sel) : undefined;
        if (modelPatch) extraArgs.push("--patch", modelPatch);

        const args = buildSpawnArgs(cli, extraArgs, t("请只回复两个字：好的", "Please reply with just: OK"));
        const result = await runDsh(cli, args, {
          cwd: folder.uri.fsPath,
          timeoutMs: 90000,
          env,
        });

        const after = walkFiles(sessionsDir);
        const newLog = after.find((f) => f.endsWith("session.jsonl") && !before.has(f));

        output.appendLine(t("任务执行: {0}", "task run: {0}").replace("{0}", result.code === 0 ? "✓ exit 0" : `✗ exit ${result.code}`));
        if (result.stderr.trim()) output.appendLine(`  stderr: ${result.stderr.trim().slice(0, 300)}`);
        output.appendLine(t("流式补丁（明文会话日志）: {0}", "streaming patch (plain session log): {0}").replace("{0}", newLog ? t("✓ 已生成", "✓ generated") : t("✗ 未生成（流式将不可用）", "✗ not generated (streaming unavailable)")));
        if (newLog) output.appendLine(t("  日志: {0}", "  log: {0}").replace("{0}", newLog));
        if (sel) output.appendLine(t("模型补丁: 已随任务传入（{0}/{1}），若任务成功即生效", "model patch: passed with task ({0}/{1}), effective if task succeeds").replace("{0}", sel.provider).replace("{1}", sel.model));
        output.appendLine("");
        output.appendLine(
          result.code === 0 && newLog
            ? t("自检通过：流式与模型机制正常。", "Self-test passed: streaming & model mechanisms OK.")
            : t("自检发现问题，请把以上输出反馈给维护者。", "Self-test found issues; please share the output above with the maintainer.")
        );
        output.show(true);
        if (result.code === 0 && newLog) {
          status.setReady(true, t("DSH 兼容性自检通过", "DSH compatibility self-test passed"));
          void vscode.window.showInformationMessage(t("DSH 兼容性自检通过。", "DSH compatibility self-test passed."));
        } else {
          status.setReady(false, t("DSH: 兼容性自检失败，查看输出面板 DSH", "DSH: self-test failed, see DSH output panel"));
          void vscode.window.showErrorMessage(t("DSH 兼容性自检失败，请查看输出面板（DSH）。", "DSH compatibility self-test failed — see the DSH output panel."));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(t("自检异常: {0}", "self-test error: {0}").replace("{0}", message));
        output.show(true);
        status.setReady(false, t("DSH: 自检异常", "DSH: self-test error"));
        void vscode.window.showErrorMessage(t("DSH 兼容性自检异常：{0}", "DSH compatibility self-test error: {0}").replace("{0}", message));
      }
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.newSession", async () => {
      const current = panel ?? ChatPanel.current();
      if (!current) {
        await vscode.commands.executeCommand("dsh-harness-vscode.openChat");
        return;
      }
      current.newSession();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.cancelRun", () => {
      const current = panel ?? ChatPanel.current();
      current?.cancel();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.addSelection", async () => {
      let current = panel ?? ChatPanel.current();
      if (!current) {
        const folder = await pickFolder();
        if (!folder) return;
        current = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
        panel = current;
      }
      current.attachSelection();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.addOpenFile", async () => {
      let current = panel ?? ChatPanel.current();
      if (!current) {
        const folder = await pickFolder();
        if (!folder) return;
        current = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
        panel = current;
      }
      current.attachOpenFile();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.askAboutFile", async (uri?: vscode.Uri) => {
      const folder = await pickFolder();
      if (!folder) return;
      const chat = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
      panel = chat;

      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;

      let content = "";
      try {
        const buf = await vscode.workspace.fs.readFile(target);
        content = Buffer.from(buf).toString("utf8");
      } catch {
        content = "（无法读取文件内容）";
      }
      const label = relPath(folder, target.fsPath);
      chat.addContextBlock({
        kind: "file",
        label,
        content: content.length > 40000 ? content.slice(0, 40000) + "\n…(文件过大，已截断)" : content,
      });
      chat.setDraft(`请分析这个文件：@${label}\n`);
    }),

    // ---- 快捷提示命令 ----

    vscode.commands.registerCommand("dsh-harness-vscode.quickExplainFile", async () => {
      const chat = await openChatWithDraft(context, cliProvider, envProvider, secrets, status, log, "请解释当前文件的结构、职责和关键逻辑。\n");
      const editor = vscode.window.activeTextEditor;
      if (chat && editor) chat.attachOpenFile();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.quickReviewChanges", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      const chat = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
      panel = chat;
      const diff = await gitDiffSummary(folder.uri.fsPath);
      if (diff) {
        chat.addContextBlock({ kind: "file", label: "git diff（当前改动）", content: diff });
      } else {
        void vscode.window.showInformationMessage("未检测到 git 改动（可能不是 git 仓库或没有未提交改动）。");
      }
      chat.setDraft(
        "请审查当前改动（git diff 已作为上下文提供）：指出潜在问题、改进建议，并说明每个文件改了什么。\n"
      );
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.quickWriteTests", async () => {
      const chat = await openChatWithDraft(
        context,
        cliProvider,
        envProvider,
        secrets,
        status,
        log,
        "请为当前文件编写单元测试，遵循项目现有的测试风格与框架。\n"
      );
      const editor = vscode.window.activeTextEditor;
      if (chat && editor) chat.attachOpenFile();
    }),

    // ---- 终端与记忆 ----

    vscode.commands.registerCommand("dsh-harness-vscode.openTerminal", async () => {
      const folder = await pickFolder();
      if (!folder) return;
      const terminal = vscode.window.createTerminal({
        name: "DSH",
        cwd: folder.uri,
      });
      terminal.show();
      // 用独立端口启动 dsh web，避免与已运行的实例冲突
      terminal.sendText("dsh web --port 3088");
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.editMemory", async () => {
      const current = panel ?? ChatPanel.current();
      if (current) {
        await current.editMemory();
        return;
      }
      const folder = await pickFolder();
      if (!folder) return;
      const chat = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
      panel = chat;
      await chat.editMemory();
    }),

    vscode.commands.registerCommand("dsh-harness-vscode.showMemory", async () => {
      const current = panel ?? ChatPanel.current();
      if (current) {
        current.showMemory();
        return;
      }
      const folder = await pickFolder();
      if (!folder) return;
      const chat = ChatPanel.open(context, folder, cliProvider, envProvider, secrets, status, log);
      panel = chat;
      chat.showMemory();
    })
  );

  // 启动后延迟检测一次新插件（不阻塞激活；无新插件时完全静默）
  setTimeout(() => {
    void cliProvider()
      .then((cli) => pluginWatch.checkOnce(cli))
      .catch(() => {});
  }, 5000);
}

export function deactivate(): void {
  // 订阅项随 extension host 退出统一释放
}
