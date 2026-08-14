import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ResolvedCli, buildSpawnArgs, runDsh } from "./cli";
import { ChatMessage, ChatSession, SessionStore, stableHash, TraceBlock } from "./sessionStore";
import { ProjectMemory } from "./memory";
import { SessionTracer, ProgressMessage } from "./sessionTracer";
import { handleSlashCommand, postMemory } from "./chatCommands";
import { attachActiveSelection, attachOpenFile, extractCodeForInsert, insertCodeToEditor } from "./projectContext";
import { buildTaskText } from "./taskText";
import { extractCodeBlocks } from "./codeBlocks";
import { applyCodeBlock } from "./applyCode";
import { renderChatHtml } from "./webviewHtml";
import { SecretStore } from "./secrets";
import {
  ModelSelection,
  loadSelection,
  saveSelection,
  writeModelPatch,
  readDefaultEffort,
  providerDisplayName,
} from "./modelSelection";
import { refreshSidebarStatus } from "./sidebar";
import { t, tf, isZh } from "./i18n";

/** 用户在输入区上方挂载的上下文块（选中代码 / 文件片段）。 */
export interface ContextBlock {
  id: string;
  kind: "file" | "selection";
  label: string;
  content: string;
}

/** 状态栏控制器，由 extension.ts 注入，避免面板直接依赖状态栏实现。 */
export interface StatusBar {
  setRunning(running: boolean): void;
  setReady(ok: boolean, message: string): void;
}

interface CliProvider {
  (): Promise<ResolvedCli>;
}

/** 构造子进程环境变量（可异步读取密钥等）。 */
interface EnvProvider {
  (): Promise<NodeJS.ProcessEnv>;
}

const UUID = () => crypto.randomUUID();

function fmtNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 把累积的思维链轨迹组装成有序的 TraceBlock 列表（无内容时返回 undefined）。 */
function buildTrace(
  order: string[],
  reasoningMap: Map<string, string>,
  toolMap: Map<string, { name: string; args: string; result?: string; isError?: boolean }>,
  goalMap: Map<string, { objective: string; operation: string }>
): TraceBlock[] | undefined {
  if (order.length === 0) return undefined;
  const blocks: TraceBlock[] = [];
  for (const key of order) {
    if (key.startsWith("r:")) {
      const text = reasoningMap.get(key.slice(2)) ?? "";
      if (text.trim()) blocks.push({ kind: "reasoning", text });
    } else if (key.startsWith("g:")) {
      const g = goalMap.get(key.slice(2));
      if (g) blocks.push({ kind: "goal", objective: g.objective, operation: g.operation });
    } else {
      const t = toolMap.get(key.slice(2));
      if (t) blocks.push({ kind: "tool", name: t.name, args: t.args, result: t.result, isError: t.isError });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

export class ChatPanel {
  private static instance: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private store: SessionStore;
  private readonly globalStorageDir: string;
  private readonly extensionPath: string;
  private readonly cliProvider: CliProvider;
  private readonly envProvider: EnvProvider;
  private readonly status: StatusBar;
  private readonly secrets: SecretStore;
  private readonly log?: (line: string) => void;
  memory: ProjectMemory;
  private folder: vscode.WorkspaceFolder;
  private folderHash = "";
  private session: ChatSession;
  contextBlocks: ContextBlock[] = [];
  selection: ModelSelection | undefined;
  enabledSkills: string[] = [];
  private lastUsage: ProgressMessage & { kind: "usage" } | undefined;
  private running = false;
  private busy = false;
  private abort: AbortController | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    cliProvider: CliProvider,
    envProvider: EnvProvider,
    secrets: SecretStore,
    status: StatusBar,
    log?: (line: string) => void
  ) {
    this.cliProvider = cliProvider;
    this.envProvider = envProvider;
    this.status = status;
    this.secrets = secrets;
    this.log = log;
    this.folder = folder;
    this.globalStorageDir = context.globalStorageUri.fsPath;
    this.extensionPath = context.extensionPath;
    this.store = new SessionStore(this.globalStorageDir, folder.uri.fsPath);
    this.memory = new ProjectMemory(folder.uri.fsPath);
    this.folderHash = stableHash(folder.uri.fsPath);
    this.selection = loadSelection(this.globalStorageDir, this.folderHash);
    this.session = this.createFreshSession();

    this.panel = vscode.window.createWebviewPanel(
      "dsh-harness-vscode-chat",
      "DSH",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))],
      }
    );
    this.panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, "media", "icon.svg"));
    this.panel.webview.html = renderChatHtml(this.panel.webview, context.extensionPath);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // 面板重新可见时全量同步状态（隐藏期间 post 被跳过，界面可能滞后）
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) this.postInit();
      },
      null,
      this.disposables
    );
    this.panel.webview.onDidReceiveMessage(
      (msg) => void this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  /** 当前存在的面板实例（可能已不可见）。 */
  static current(): ChatPanel | undefined {
    return ChatPanel.instance;
  }

  /** 打开（或复用）对话面板。 */
  static open(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    cliProvider: CliProvider,
    envProvider: EnvProvider,
    secrets: SecretStore,
    status: StatusBar,
    log?: (line: string) => void
  ): ChatPanel {
    if (ChatPanel.instance && !ChatPanel.instance.panelVisible()) {
      ChatPanel.instance.dispose();
      ChatPanel.instance = undefined;
    }
    if (ChatPanel.instance) {
      if (ChatPanel.instance.folder.uri.fsPath !== folder.uri.fsPath) {
        // 换了工作区：切换目录并新建会话
        ChatPanel.instance.switchFolder(folder);
      }
      ChatPanel.instance.reveal();
      return ChatPanel.instance;
    }
    ChatPanel.instance = new ChatPanel(context, folder, cliProvider, envProvider, secrets, status, log);
    ChatPanel.instance.reveal();
    return ChatPanel.instance;
  }

  private panelVisible(): boolean {
    return this.panel.visible;
  }

  private reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  // ---------------------------------------------------------------- 会话管理

  private createFreshSession(): ChatSession {
    return {
      id: UUID(),
      title: t("新会话", "New session"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
  }

  private switchFolder(folder: vscode.WorkspaceFolder): void {
    this.folder = folder;
    this.folderHash = stableHash(folder.uri.fsPath);
    this.store = new SessionStore(this.globalStorageDir, folder.uri.fsPath);
    this.memory = new ProjectMemory(folder.uri.fsPath);
    this.selection = loadSelection(this.globalStorageDir, this.folderHash);
    this.enabledSkills = [];
    this.contextBlocks = [];
    this.session = this.createFreshSession();
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.post({ type: "contextChanged", blocks: [] });
    this.post({ type: "resetMessages" });
  }

  newSession(): void {
    if (this.running) this.cancel();
    this.session = this.createFreshSession();
    this.contextBlocks = [];
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.post({ type: "contextChanged", blocks: [] });
    this.post({ type: "resetMessages" });
  }

  private loadSession(id: string): void {
    const loaded = this.store.load(id);
    if (!loaded) {
      void vscode.window.showWarningMessage(`会话不存在或已损坏: ${id}`);
      return;
    }
    if (this.running) this.cancel();
    this.session = loaded;
    this.contextBlocks = [];
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.post({ type: "resetMessages" });
    this.post({ type: "appendMessages", messages: loaded.messages });
    this.panel.title = `DSH — ${loaded.title}`;
  }

  private async listSessions(): Promise<void> {
    const summaries = this.store.list();
    if (summaries.length === 0) {
      void vscode.window.showInformationMessage(t("当前目录还没有历史会话。", "No session history in this directory yet."));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      summaries.map((s) => ({
        label: s.title,
        description: `${s.messageCount} 条消息`,
        detail: new Date(s.updatedAt).toLocaleString(),
        id: s.id,
      })),
      { placeHolder: t("选择要载入的会话", "Choose a session to load") }
    );
    if (pick) this.loadSession(pick.id);
  }

  // ---------------------------------------------------------------- 消息收发

  post(message: unknown): void {
    if (this.panelVisible()) {
      void this.panel.webview.postMessage(message);
    }
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      await this.dispatchMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "appendMessage", message: this.systemMessage(`操作出错：${message}`) });
    }
  }

  private async dispatchMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postInit();
        break;
      case "send": {
        const text = typeof msg.text === "string" ? msg.text : "";
        await this.sendMessage(text);
        break;
      }
      case "cancel":
        this.cancel();
        break;
      case "newSession":
        this.newSession();
        break;
      case "listSessions":
        await this.listSessions();
        break;
      case "loadSession":
        if (typeof msg.id === "string") this.loadSession(msg.id);
        break;
      case "removeContext":
        if (typeof msg.id === "string") {
          this.contextBlocks = this.contextBlocks.filter((b) => b.id !== msg.id);
          this.post({ type: "contextChanged", blocks: this.contextBlocks });
        }
        break;
      case "openFile": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) break;
        const raw = path.isAbsolute(p) ? p : path.join(this.folder.uri.fsPath, p);
        const abs = path.resolve(raw);
        const root = path.resolve(this.folder.uri.fsPath);
        // 安全：只允许打开工作区内的文件，防止回答里的 ../ 越界
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          void vscode.window.showWarningMessage(`出于安全，拒绝打开工作区外的文件：${p}`);
          break;
        }
        const line = typeof msg.line === "number" ? msg.line : undefined;
        const opts: vscode.TextDocumentShowOptions = {
          preview: true,
          ...(line && line > 0
            ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) }
            : {}),
        };
        void vscode.window
          .showTextDocument(vscode.Uri.file(abs), opts)
          .then(undefined, () => void vscode.window.showWarningMessage(`无法打开文件：${p}`));
        break;
      }
      case "insertCode": {
        if (typeof msg.id === "string") this.insertCodeFromMessage(msg.id);
        break;
      }
      case "applyToFiles": {
        if (typeof msg.id === "string") await this.applyToFiles(msg.id);
        break;
      }
      case "attachSelection":
        this.attachSelection();
        break;
      case "attachOpenFile":
        this.attachOpenFile();
        break;
      case "command":
        if (typeof msg.text === "string") this.handleSlashCommand(msg.text);
        break;
      case "openExternal": {
        if (typeof msg.url === "string") {
          try {
            void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          } catch {
            // 非法 URL 直接忽略
          }
        }
        break;
      }
    }
  }

  private postInit(): void {
    this.post({
      type: "init",
      sessionId: this.session.id,
      title: this.session.title,
      messages: this.session.messages,
      blocks: this.contextBlocks,
      running: this.running,
      folder: this.folder.uri.fsPath,
      selection: this.selection,
      effort: this.effectiveEffort(),
      usage: this.lastUsage,
      skills: this.enabledSkills,
    });
  }

  private updateTitleFromSession(): void {
    // DSH 已生成标题（session/title 事件）时保留，不再用首条消息截断覆盖
    if (this.session.dshTitle) {
      this.panel.title = `DSH — ${this.session.title}`;
      return;
    }
    const firstUser = this.session.messages.find((m) => m.role === "user");
    if (firstUser) {
      const title = firstUser.content.replace(/\s+/g, " ").trim().slice(0, 40);
      this.session.title = title || t("新会话", "New session");
    }
    this.panel.title = `DSH — ${this.session.title}`;
  }

  private async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.running || this.busy) return;

    const userMsg: ChatMessage = { id: UUID(), role: "user", content: trimmed, ts: Date.now() };
    this.session.messages.push(userMsg);
    this.updateTitleFromSession();
    this.store.save(this.session);
    this.post({ type: "appendMessage", message: userMsg });

    this.running = true;
    this.abort = new AbortController();
    this.post({ type: "running", running: true });
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.status.setRunning(true);

    try {
      const outcome = await this.executeTask(this.abort);
      this.session.messages.push(outcome);
      this.store.save(this.session);
      this.post({ type: "appendMessage", message: outcome });
    } finally {
      // 无论成功失败都复位运行态，避免卡在「运行中」无法再发送
      this.running = false;
      this.abort = undefined;
      this.post({ type: "running", running: false });
      this.status.setRunning(false);
    }
  }

  /** 执行一次 headless 任务，返回要追加到会话的消息。 */
  private async executeTask(abort: AbortController): Promise<ChatMessage> {
    let cli: ResolvedCli;
    try {
      cli = await this.cliProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.setReady(false, `DSH: ${message}`);
      return this.systemMessage(tf(t("无法解析 dsh 命令：{0}", "Cannot resolve dsh command: {0}"), message));
    }
    try {
      const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
      const extraArgs = cfg.get<string[]>("extraArgs", []);
      const timeoutSec = cfg.get<number>("timeoutSeconds", 600);
      const streamProgress = cfg.get<boolean>("streamProgress", true);

      const taskText = this.buildTaskText();
      const modelPatch = this.currentModelPatch();
      if (streamProgress) {
        // 附加流式补丁：明文 JSONL 会话日志 + 更低的落盘批次延迟
        extraArgs.push("--patch", path.join(this.extensionPath, "patch", "stream.patch.yml"));
      }
      if (modelPatch) {
        // 附加模型选择补丁（/provider /model /effort）
        extraArgs.push("--patch", modelPatch);
      }
      const args = buildSpawnArgs(cli, extraArgs, taskText);
      const env = await this.envProvider();

      // 实时追踪会话事件日志 → 思维链 / 工具调用进度 / 用量
      let tracer: SessionTracer | undefined;
      let tracerDone: Promise<void> = Promise.resolve();
      // 思维链轨迹累积（保留到回答里，可折叠展示）
      const traceOrder: string[] = [];
      const reasoningMap = new Map<string, string>();
      const toolMap = new Map<string, { name: string; args: string; result?: string; isError?: boolean }>();
      const goalMap = new Map<string, { objective: string; operation: string }>();
      // 已收到权威完整块（block-end）的键：后续增量碎片不再累加，避免双写
      const sealedKeys = new Set<string>();
      const recordTrace = (msg: ProgressMessage) => {
        if (msg.kind === "goal") {
          if (!goalMap.has(msg.id)) {
            goalMap.set(msg.id, { objective: msg.objective, operation: msg.operation });
            traceOrder.push(`g:${msg.id}`);
          } else {
            const g = goalMap.get(msg.id)!;
            g.objective = msg.objective;
            g.operation = msg.operation;
          }
        } else if (msg.kind === "reasoning") {
          if (sealedKeys.has(msg.key)) return;
          if (!reasoningMap.has(msg.key)) {
            reasoningMap.set(msg.key, "");
            traceOrder.push(`r:${msg.key}`);
          }
          // 同 (turn,step,index) 内若分多批则累加；跨 step 是不同 key，各自成段
          reasoningMap.set(msg.key, (reasoningMap.get(msg.key) ?? "") + msg.text);
        } else if (msg.kind === "block") {
          if (msg.blockType === "reasoning" && msg.text) {
            sealedKeys.add(msg.key);
            if (!reasoningMap.has(msg.key)) traceOrder.push(`r:${msg.key}`);
            reasoningMap.set(msg.key, msg.text);
          } else if (msg.blockType === "text") {
            sealedKeys.add(msg.key);
          } else if (msg.blockType === "tool-call") {
            const id = msg.callId || msg.key;
            if (!toolMap.has(id)) {
              toolMap.set(id, { name: msg.name ?? "tool", args: msg.args ?? "" });
              traceOrder.push(`t:${id}`);
            } else {
              const t = toolMap.get(id)!;
              if (msg.args) t.args = msg.args;
              if (msg.name) t.name = msg.name;
            }
          }
        } else if (msg.kind === "tool") {
          if (!toolMap.has(msg.callId)) {
            toolMap.set(msg.callId, { name: msg.name, args: msg.args });
            traceOrder.push(`t:${msg.callId}`);
          } else if (msg.args) {
            const t = toolMap.get(msg.callId)!;
            t.args = msg.args;
          }
        } else if (msg.kind === "tool-result") {
          const t = toolMap.get(msg.callId);
          if (t) {
            t.result = msg.summary;
            t.isError = msg.isError;
          }
        }
      };
      if (streamProgress) {
        tracer = new SessionTracer(env, Date.now(), (line) => this.log?.(line));
        tracerDone = tracer.start(
          (msg) => {
            if (msg.kind === "usage") {
              this.lastUsage = msg;
              this.post({ type: "usage", ...msg, effort: this.effectiveEffort() });
            } else if (msg.kind === "title") {
              // DSH 生成的会话标题：更新面板标题与会话记录，并同步前端
              this.session.title = msg.title;
              this.session.dshTitle = msg.title;
              this.panel.title = `DSH — ${msg.title}`;
              this.post({ type: "sessionChanged", sessionId: this.session.id, title: msg.title });
            } else {
              recordTrace(msg);
              this.post({ type: "progress", msg });
            }
          },
          abort.signal
        );
      }

      const result = await runDsh(cli, args, {
        cwd: this.folder.uri.fsPath,
        timeoutMs: timeoutSec * 1000,
        env,
        signal: abort.signal,
      });

      tracer?.finish();
      await tracerDone;

      if (abort.signal.aborted) {
        return this.systemMessage(t("已取消任务。", "Task cancelled."));
      }
      if (result.timedOut) {
        return this.systemMessage(
          tf(t("任务超时（超过 {0} 秒）已被取消。可在设置 dsh-harness-vscode.timeoutSeconds 中调整。", "Task timed out after {0}s and was cancelled. Adjust dsh-harness-vscode.timeoutSeconds in settings."), timeoutSec)
        );
      }
      if (result.code !== 0) {
        const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        if (/MISSING_CREDENTIAL|no API key/i.test(result.stderr)) {
          return this.systemMessage(
            t(
              `检测到未配置 API Key。请执行「DSH: 配置 API Key」输入 DeepSeek API Key（sk-...），或在系统环境变量中设置 DEEPSEEK_API_KEY。\n\n原始错误：\n${detail}`,
              `No API key configured. Run "DSH: Set API Key" to enter your DeepSeek API key (sk-...), or set DEEPSEEK_API_KEY in your environment.\n\nRaw error:\n${detail}`
            )
          );
        }
        return this.systemMessage(
          tf(t("dsh 任务失败（exit code {0}）{1}", "dsh task failed (exit code {0}){1}"), result.code ?? "?", detail ? `:\n${detail}` : "")
        );
      }
      const answer = result.stdout.trim();
      let content = answer.length > 0 ? answer : t("（dsh 未返回文本输出）", "(dsh returned no text output)");
      if (tracer && cfg.get<boolean>("debugStreaming", false)) {
        const s = tracer.stats();
        content +=
          "\n\n— " +
          t("流式诊断：", "Streaming diagnostics: ") +
          (s.found
            ? tf(t("已 tail 会话日志，解析 {0} 条事件", "tailed session log, parsed {0} events"), s.eventsParsed)
            : t("未找到明文会话日志（--patch 未生效：请确认 dsh 版本支持 compression: none，或查看输出面板 DSH 日志）", "No plain session log found (--patch not effective: check dsh supports compression: none, or see the DSH output panel)"));
      }
      return {
        id: UUID(),
        role: "assistant",
        content,
        ts: Date.now(),
        trace: buildTrace(traceOrder, reasoningMap, toolMap, goalMap),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.systemMessage(tf(t("运行 dsh 失败：{0}", "Failed to run dsh: {0}"), message));
    }
  }

  systemMessage(content: string): ChatMessage {
    return { id: UUID(), role: "system", content, ts: Date.now() };
  }

  // ---------------------------------------------------------------- 上下文与任务文本

  /** 把当前编辑器选中内容加入上下文。 */
  attachSelection(): void {
    attachActiveSelection(this.folder.uri.fsPath, (b) => this.addContextBlock(b));
  }

  /** 把当前打开文件的内容加入上下文（截断保护）。 */
  attachOpenFile(): void {
    attachOpenFile(this.folder.uri.fsPath, (b) => this.addContextBlock(b));
  }

  /** 预填输入框（配合 @file 引用等场景）。 */
  setDraft(text: string): void {
    this.post({ type: "setDraft", text });
  }

  // ---------------------------------------------------------------- 命令与记忆

  private handleSlashCommand(raw: string): void {
    handleSlashCommand(this, raw);
  }

  // ---- ChatCommandHost 实现 ----

  get folderPath(): string {
    return this.folder.uri.fsPath;
  }

  async setSelection(sel: ModelSelection | undefined): Promise<void> {
    this.selection = sel;
    saveSelection(this.globalStorageDir, this.folderHash, sel);
    // 立即通知前端更新状态栏/用量显示，并刷新侧边栏
    this.post({ type: "selectionChanged", selection: this.selection, effort: this.effectiveEffort() });
    refreshSidebarStatus();
  }

  setEnabledSkills(names: string[]): void {
    this.enabledSkills = names;
  }

  getEnvSecret(name: string): Promise<string | undefined> {
    return this.secrets.get(name);
  }

  setEnvSecret(name: string, value: string): Promise<void> {
    return this.secrets.set(name, value);
  }

  /** 跑一次不落聊天记录的一次性任务（用于 /compact）。 */
  async runHeadlessTask(task: string): Promise<string | null> {
    this.busy = true;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120000);
    try {
      const cli = await this.cliProvider();
      const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
      const extraArgs = cfg.get<string[]>("extraArgs", []);
      extraArgs.push("--patch", path.join(this.extensionPath, "patch", "stream.patch.yml"));
      const modelPatch = this.currentModelPatch();
      if (modelPatch) extraArgs.push("--patch", modelPatch);
      const args = buildSpawnArgs(cli, extraArgs, task);
      const env = await this.envProvider();
      const result = await runDsh(cli, args, {
        cwd: this.folder.uri.fsPath,
        timeoutMs: 120000,
        env,
        signal: abort.signal,
      });
      return result.code === 0 ? result.stdout.trim() || null : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }

  getTranscript(): string {
    return this.session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
      .join("\n\n")
      .slice(-60000);
  }

  replaceSessionWithSummary(summary: string): void {
    const compacted = this.systemMessage(`（会话已压缩，原 ${this.session.messages.length} 条消息被替换为以下摘要）\n${summary}`);
    this.session = {
      id: this.session.id,
      title: this.session.title,
      createdAt: this.session.createdAt,
      updatedAt: Date.now(),
      messages: [compacted],
    };
    this.store.save(this.session);
    this.post({ type: "resetMessages" });
    this.post({ type: "appendMessage", message: compacted });
  }

  /** 生效的思维强度：优先用户选择，其次 settings 默认。 */
  private effectiveEffort(): string | undefined {
    return this.selection?.reasoningEffort ?? readDefaultEffort();
  }

  statusLine(): string {
    const sel = this.selection;
    const provider = sel?.provider ? providerDisplayName(sel.provider) : "（DSH 默认）";
    const model = sel?.model ?? "（DSH 默认）";
    const effort = this.effectiveEffort() ?? "未设置";
    const skills = this.enabledSkills.length ? this.enabledSkills.join("、") : "无";
    const mode = vscode.workspace.getConfiguration("dsh-harness-vscode").get<string>("permissionMode", "workspace-write");
    const usage = this.lastUsage
      ? `\n用量：输入 ${fmtNum(this.lastUsage.input)} · 输出 ${fmtNum(this.lastUsage.output)} · 缓存读 ${fmtNum(this.lastUsage.cacheRead)} · 推理 ${fmtNum(this.lastUsage.reasoning)} token` +
        (this.lastUsage.cacheRead + this.lastUsage.input > 0
          ? ` · 缓存命中 ${Math.round((this.lastUsage.cacheRead / (this.lastUsage.cacheRead + this.lastUsage.input)) * 100)}%`
          : "")
      : "";
    return `提供商：${provider}\n模型：${model}（思维强度 ${effort}）\n沙箱模式：${mode}\n已启用技能：${skills}${usage}`;
  }

  /** 当前模型选择对应的 --patch 文件（无选择时 undefined）。 */
  private currentModelPatch(): string | undefined {
    if (!this.selection) return undefined;
    return writeModelPatch(this.globalStorageDir, this.folderHash, this.selection);
  }

  /** 在聊天中展示项目长期记忆。 */
  showMemory(): void {
    postMemory(this);
  }

  /** 在编辑器中打开项目记忆文件（不存在则创建）。 */
  async editMemory(): Promise<void> {
    const file = path.join(this.folder.uri.fsPath, ".dsh", "memory.md");
    if (!this.memory.exists()) {
      const fs = await import("fs");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        "# 项目长期记忆\n\n在这里记录项目的关键约定、架构决策、常用命令等，DSH 每次任务会自动参考。\n",
        "utf8"
      );
    }
    void (await vscode.window.showTextDocument(vscode.Uri.file(file)));
    this.reveal();
  }

  addContextBlock(block: Omit<ContextBlock, "id">): void {
    const full: ContextBlock = { ...block, id: UUID() };
    this.contextBlocks = [...this.contextBlocks, full];
    this.post({ type: "contextChanged", blocks: this.contextBlocks });
    this.reveal();
  }

  private buildTaskText(): string {
    const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
    const historyN = cfg.get<number>("historyMessages", 20);
    const maxChars = cfg.get<number>("maxMessageChars", 8000);

    const extraSections: string[] = [];
    const sel = this.selection;
    if (sel?.provider && sel.model) {
      extraSections.push(
        t("本会话模型配置：提供商 {0}，模型 {1}", "Session model config: provider {0}, model {1}")
          .replace("{0}", sel.provider).replace("{1}", sel.model) +
          (this.effectiveEffort() ? t("，思维强度 {0}", ", effort {0}").replace("{0}", this.effectiveEffort()!) : "")
      );
    }
    if (this.enabledSkills.length > 0) {
      extraSections.push(t("本会话已启用技能：{0}（按需通过技能工具加载）", "Skills enabled in this session: {0} (load on demand via the skill tool)").replace("{0}", this.enabledSkills.join(t("、", ", "))));
    }

    return buildTaskText(
      this.folder.uri.fsPath,
      this.session,
      this.contextBlocks,
      this.memory,
      historyN,
      maxChars,
      extraSections,
      !isZh()
    );
  }

  // ---------------------------------------------------------------- 其它

  cancel(): void {
    if (this.running) {
      this.abort?.abort();
    }
  }

  private insertCodeFromMessage(messageId: string): void {
    const msg = this.session.messages.find((m) => m.id === messageId);
    if (!msg) return;
    insertCodeToEditor(extractCodeForInsert(msg.content));
  }

  /** 把回答中的代码块写入项目文件（带路径猜测与确认）。 */
  private async applyToFiles(messageId: string): Promise<void> {
    const msg = this.session.messages.find((m) => m.id === messageId);
    if (!msg) return;
    const blocks = extractCodeBlocks(msg.content);
    if (blocks.length === 0) {
      void vscode.window.showWarningMessage(t("这段回答里没有可应用的代码块。", "No applicable code blocks in this answer."));
      return;
    }
    if (blocks.length === 1) {
      await applyCodeBlock(this.folder.uri.fsPath, blocks[0]);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      blocks.map((b, i) => ({
        label: b.pathHint ?? `代码块 ${i + 1}（${b.language || "text"}）`,
        description: b.code.slice(0, 80).replace(/\n/g, " "),
        block: b,
      })),
      { placeHolder: "选择要应用哪个代码块" }
    );
    if (pick) await applyCodeBlock(this.folder.uri.fsPath, pick.block);
  }

  private dispose(): void {
    this.abort?.abort();
    for (const d of this.disposables) {
      d.dispose();
    }
    if (ChatPanel.instance === this) {
      ChatPanel.instance = undefined;
    }
  }
}
