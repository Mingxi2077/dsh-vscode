import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { ResolvedCli, buildSpawnArgs, runDsh, normalizeExtraArgs } from "./cli";
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
import { PluginWatch } from "./pluginWatch";
import {
  ModelSelection,
  loadSelection,
  saveSelection,
  writeModelPatch,
  readDefaultEffort,
  providerDisplayName,
} from "./modelSelection";
import { refreshSidebarStatus } from "./sidebar";
import { resolveExistingInsideRoot } from "./pathSafety";
import { isAnyTaskActive, setTaskActive } from "./taskGuard";
import { agentModeById, resolveAgentModePatch } from "./agentModes";
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
  private readonly context: vscode.ExtensionContext;
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
  private backgroundAbort: AbortController | undefined;
  private disposed = false;
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
    this.context = context;
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

  /** 是否有主任务或后台任务（/compact）正在运行。 */
  isActive(): boolean {
    return this.running || this.busy;
  }

  /** 打开（或复用）对话面板。
   * 即使面板暂时不可见（被其它编辑器标签盖住）也复用实例：reveal 后 onDidChangeViewState
   * 会触发 postInit 全量同步。此前这里会 dispose 重建，导致当前未落盘的会话被丢成新会话。 */
  static open(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder,
    cliProvider: CliProvider,
    envProvider: EnvProvider,
    secrets: SecretStore,
    status: StatusBar,
    log?: (line: string) => void
  ): ChatPanel {
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

  /** 后台任务（/compact）进行中时禁止切换会话，防止压缩结果套到新会话上。 */
  private sessionSwitchBlocked(): boolean {
    if (!this.busy) return false;
    this.post({
      type: "appendMessage",
      message: this.systemMessage(
        t("后台任务（如 /compact）进行中，请稍候再切换会话。", "A background task (e.g. /compact) is running; please wait before switching sessions.")
      ),
    });
    return true;
  }

  private switchFolder(folder: vscode.WorkspaceFolder): void {
    if (this.running) this.cancel();
    if (this.sessionSwitchBlocked()) return;
    this.folder = folder;
    this.folderHash = stableHash(folder.uri.fsPath);
    this.store = new SessionStore(this.globalStorageDir, folder.uri.fsPath);
    this.memory = new ProjectMemory(folder.uri.fsPath);
    this.selection = loadSelection(this.globalStorageDir, this.folderHash);
    this.enabledSkills = [];
    this.contextBlocks = [];
    this.lastUsage = undefined;
    this.session = this.createFreshSession();
    this.panel.title = `DSH — ${this.session.title}`;
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.post({ type: "contextChanged", blocks: [] });
    this.post({ type: "selectionChanged", selection: this.selection, effort: this.effectiveEffort() });
    this.post({ type: "usage", usage: null });
    this.post({ type: "resetMessages" });
  }

  newSession(): void {
    if (this.running) this.cancel();
    if (this.sessionSwitchBlocked()) return;
    this.session = this.createFreshSession();
    this.contextBlocks = [];
    this.lastUsage = undefined;
    this.panel.title = `DSH — ${this.session.title}`;
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.post({ type: "contextChanged", blocks: [] });
    this.post({ type: "usage", usage: null });
    this.post({ type: "resetMessages" });
  }

  private loadSession(id: string): void {
    const loaded = this.store.load(id);
    if (!loaded) {
      void vscode.window.showWarningMessage(t("会话不存在或已损坏: {0}", "Session does not exist or is corrupted: {0}").replace("{0}", id));
      return;
    }
    if (this.running) this.cancel();
    if (this.sessionSwitchBlocked()) return;
    this.session = loaded;
    this.contextBlocks = [];
    this.lastUsage = undefined;
    this.post({ type: "sessionChanged", sessionId: this.session.id, title: this.session.title });
    this.post({ type: "contextChanged", blocks: [] });
    this.post({ type: "usage", usage: null });
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
        description: tf(t("{0} 条消息", "{0} messages"), s.messageCount),
        detail: new Date(s.updatedAt).toLocaleString(),
        id: s.id,
      })),
      { placeHolder: t("选择要载入的会话", "Choose a session to load") }
    );
    if (pick) this.loadSession(pick.id);
  }

  // ---------------------------------------------------------------- 消息收发

  post(message: unknown): void {
    if (this.disposed || !this.panelVisible()) return;
    try {
      this.panel.webview.postMessage(message).then(undefined, () => {
        // 面板可能恰在 postMessage 前被关闭；消息丢失可接受，不能让宿主出现未处理拒绝
      });
    } catch {
      // 防御面板已 dispose 时 postMessage 同步抛错
    }
  }

  /** 仅当面板仍停留在发起任务的那个会话时才向 webview 推送（防旧任务污染新会话 UI）。 */
  private postIfCurrent(session: ChatSession, message: unknown): void {
    if (this.session === session) this.post(message);
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      await this.dispatchMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "appendMessage", message: this.systemMessage(tf(t("操作出错：{0}", "Operation failed: {0}"), message)) });
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
        // 安全：只允许打开工作区内的文件；用 realpath 复核，防 ../ 越界与区外符号链接
        const safe = resolveExistingInsideRoot(this.folder.uri.fsPath, raw);
        if (!safe.ok || !safe.realPath) {
          void vscode.window.showWarningMessage(
            t(
              `无法打开 {0}：文件不存在、位于工作区外，或经符号链接指向区外。`,
              `Cannot open {0}: it is missing, outside the workspace, or linked out of the workspace.`
            ).replace("{0}", p)
          );
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
          .showTextDocument(vscode.Uri.file(safe.realPath), opts)
          .then(undefined, () => void vscode.window.showWarningMessage(tf(t("无法打开文件：{0}", "Cannot open file: {0}"), p)));
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
            const uri = vscode.Uri.parse(msg.url);
            // 仅允许 http/https：模型内容/被篡改的 webview 不能诱导打开 file:// 或其它协议
            if (uri.scheme === "http" || uri.scheme === "https") {
              void vscode.env.openExternal(uri);
            }
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
      busy: this.busy,
      folder: this.folder.uri.fsPath,
      selection: this.selection,
      mode: this.selection?.mode,
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
    if (!trimmed) return;
    const participantBusy = !this.running && !this.busy && isAnyTaskActive();
    if (this.running || this.busy || participantBusy) {
      // 韧性：不能让用户输入被静默吞掉——回显原因并恢复草稿
      this.post({
        type: "appendMessage",
        message: this.systemMessage(
          this.running
            ? t("已有任务运行中，请等待完成或先取消。", "A task is already running; wait for it or cancel it first.")
            : this.busy
              ? t("后台任务（如 /compact）进行中，请稍候再发送。", "A background task (e.g. /compact) is running; please wait before sending.")
              : t("DSH 正在执行其它任务（自检/环境检查/插件操作等），请稍候再发送。", "DSH is busy with another operation (self-test / environment check / plugin action); please wait before sending.")
        ),
      });
      this.post({ type: "setDraft", text });
      return;
    }

    // 任务会话快照：运行中即使切换目录/新建会话，结果也只落回发起时的会话，
    // 不会污染新会话（0.9.8 已修取消竞态，这里补齐“结果归属”竞态）。
    const taskSession = this.session;
    const taskStore = this.store;

    const userMsg: ChatMessage = { id: UUID(), role: "user", content: trimmed, ts: Date.now() };
    taskSession.messages.push(userMsg);
    this.updateTitleFromSession();
    taskStore.save(taskSession);
    this.postIfCurrent(taskSession, { type: "appendMessage", message: userMsg });

    this.running = true;
    this.abort = new AbortController();
    setTaskActive("panel", true);
    this.postIfCurrent(taskSession, { type: "running", running: true });
    this.postIfCurrent(taskSession, { type: "sessionChanged", sessionId: taskSession.id, title: taskSession.title });
    this.status.setRunning(true);

    try {
      const outcome = await this.executeTask(this.abort, taskSession);
      taskSession.messages.push(outcome);
      taskStore.save(taskSession);
      this.postIfCurrent(taskSession, { type: "appendMessage", message: outcome });
    } finally {
      // 无论成功失败都复位运行态，避免卡在「运行中」无法再发送。
      // 状态栏是全局单例：若旧面板已关闭并已有新面板在跑任务，旧任务不能把新任务的运行态抹掉。
      this.running = false;
      this.abort = undefined;
      setTaskActive("panel", this.busy);
      this.post({ type: "running", running: false });
      if (ChatPanel.current() === this || !ChatPanel.current()) {
        this.status.setRunning(false);
      }
    }
  }

  /** 执行一次 headless 任务，返回要追加到发起会话的消息。 */
  private async executeTask(abort: AbortController, taskSession: ChatSession): Promise<ChatMessage> {
    // 任务快照必须全部在第一个 await 之前取好：await 期间用户可能 /provider、
    // 切换目录或新建会话，动态读取 this.* 会把新会话的内容塞进旧任务。
    let extraArgs: string[];
    let timeoutSec: number;
    let streamProgress: boolean;
    let debugStreaming: boolean;
    let folderPath: string;
    let folderHash: string;
    let selection: ModelSelection | undefined;
    let enabledSkills: string[];
    let taskText: string;
    let modelPatch: string | undefined;
    try {
      const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
      extraArgs = normalizeExtraArgs(cfg.get("extraArgs", []));
      // settings.json 可以绕过 UI 的 min/max：运行期再按配置声明夹紧一次
      const rawTimeout = cfg.get<number>("timeoutSeconds", 600);
      timeoutSec = Number.isFinite(rawTimeout) ? Math.min(7200, Math.max(30, rawTimeout)) : 600;
      const rawStream = cfg.get<unknown>("streamProgress", true);
      streamProgress = typeof rawStream === "boolean" ? rawStream : rawStream !== "false";
      const rawDebug = cfg.get<unknown>("debugStreaming", false);
      debugStreaming = typeof rawDebug === "boolean" ? rawDebug : rawDebug === "true";
      folderPath = this.folder.uri.fsPath;
      folderHash = this.folderHash;
      selection = this.selection;
      enabledSkills = [...this.enabledSkills];
      taskText = this.buildTaskTextFor(taskSession, this.folder, this.contextBlocks, selection, enabledSkills);
      modelPatch = selection ? writeModelPatch(this.globalStorageDir, folderHash, selection) : undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.systemMessage(tf(t("准备任务失败：{0}", "Failed to prepare the task: {0}"), message));
    }

    let cli: ResolvedCli;
    try {
      cli = await this.cliProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (ChatPanel.current() === this || !ChatPanel.current()) {
        this.status.setReady(false, `DSH: ${message}`);
      }
      return this.systemMessage(tf(t("无法解析 dsh 命令：{0}", "Cannot resolve dsh command: {0}"), message));
    }
    let tracer: SessionTracer | undefined;
    let tracerDone: Promise<void> = Promise.resolve();
    try {
      if (streamProgress) {
        // 附加流式补丁：明文 JSONL 会话日志 + 更低的落盘批次延迟
        extraArgs.push("--patch", path.join(this.extensionPath, "patch", "stream.patch.yml"));
      }
      if (modelPatch) {
        // 附加模型选择补丁（/provider /model /effort）
        extraArgs.push("--patch", modelPatch);
      }
      if (selection?.mode) {
        // 附加 DSH Agent 预设（标准 / PTC / 极简 / 创造）：直接叠加预设目录的 agent.cordis.yml
        const modeRes = resolveAgentModePatch(cli, selection.mode);
        if (modeRes.patch) {
          extraArgs.push("--patch", modeRes.patch);
        } else if (modeRes.error) {
          const modeInfo = agentModeById(selection.mode);
          this.log?.(`agent mode patch unavailable: ${modeRes.error}`);
          this.postIfCurrent(taskSession, {
            type: "appendMessage",
            message: this.systemMessage(
              tf(
                t("警告：{0}的预设文件不可用（{1}），本次任务将按默认组装运行。", "Warning: the {0} preset file is unavailable ({1}); this task will run with the default composition."),
                modeInfo ? t(modeInfo.name, modeInfo.nameEn) : selection.mode,
                modeRes.error
              )
            ),
          });
        }
      }
      const args = buildSpawnArgs(cli, extraArgs, taskText);
      const env = await this.envProvider();

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
            const current = this.session === taskSession;
            if (msg.kind === "usage") {
              if (current) {
                this.lastUsage = msg;
                this.post({ type: "usage", usage: { ...msg, effort: this.effectiveEffort() } });
              }
            } else if (msg.kind === "title") {
              // DSH 生成的会话标题：先更新任务会话记录；只有仍是当前会话才改 UI
              taskSession.title = msg.title;
              taskSession.dshTitle = msg.title;
              if (current) {
                this.panel.title = `DSH — ${msg.title}`;
                this.post({ type: "sessionChanged", sessionId: taskSession.id, title: msg.title });
              }
            } else {
              recordTrace(msg);
              this.postIfCurrent(taskSession, { type: "progress", msg });
            }
          },
          abort.signal
        );
      }

      const result = await runDsh(cli, args, {
        cwd: folderPath,
        timeoutMs: timeoutSec * 1000,
        env,
        signal: abort.signal,
      });

      // 任务中 agent 可能直接装了插件（绕过插件中心 UI）：自动补一次兼容性检测
      void new PluginWatch(this.context).checkOnce(cli).catch(() => {});

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
        // MISSING_CREDENTIAL 可能出现在 stdout 或 stderr，两流合并后判断
        if (/MISSING_CREDENTIAL|no API key/i.test(detail)) {
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
      if (tracer && debugStreaming) {
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
    } finally {
      // 无论成功/失败/异常都必须结束 tracer，否则其轮询循环永不退出（资源泄漏）
      tracer?.finish();
      await tracerDone;
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
    // 并发守卫：主任务、另一个后台任务或 @dsh-agent 运行时不再启动新的 dsh 子进程
    if (this.running || this.busy || isAnyTaskActive()) return null;
    this.busy = true;
    setTaskActive("panel", true);
    this.post({ type: "busy", busy: true });
    const abort = new AbortController();
    this.backgroundAbort = abort;
    const timer = setTimeout(() => abort.abort(), 120000);
    // busy 期间已阻止会话切换，但仍把目录/选择快照在 await 前取好，防 /provider 并发修改
    const folderPath = this.folder.uri.fsPath;
    const folderHash = this.folderHash;
    const selection = this.selection;
    let modelPatch: string | undefined;
    try {
      modelPatch = selection ? writeModelPatch(this.globalStorageDir, folderHash, selection) : undefined;
    } catch (err) {
      // 模型补丁写失败不阻塞压缩；绝不能把 busy 状态卡死
      this.log?.(`runHeadlessTask model patch failed: ${err instanceof Error ? err.message : String(err)}`);
      modelPatch = undefined;
    }
    try {
      const cli = await this.cliProvider();
      const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
      const extraArgs = normalizeExtraArgs(cfg.get("extraArgs", []));
      extraArgs.push("--patch", path.join(this.extensionPath, "patch", "stream.patch.yml"));
      if (modelPatch) extraArgs.push("--patch", modelPatch);
      if (selection?.mode) {
        const modeRes = resolveAgentModePatch(cli, selection.mode);
        if (modeRes.patch) extraArgs.push("--patch", modeRes.patch);
        else this.log?.(`runHeadlessTask mode patch unavailable: ${modeRes.error}`);
      }
      const args = buildSpawnArgs(cli, extraArgs, task);
      const env = await this.envProvider();
      const result = await runDsh(cli, args, {
        cwd: folderPath,
        timeoutMs: 120000,
        env,
        signal: abort.signal,
      });
      // 后台工具子任务也可能安装插件：同样补一次检测
      void new PluginWatch(this.context).checkOnce(cli).catch(() => {});
      return result.code === 0 ? result.stdout.trim() || null : null;
    } catch (err) {
      // 记录原因，便于定位（/compact 失败不再是无从查起的"压缩失败"）
      this.log?.(`runHeadlessTask failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
      if (this.backgroundAbort === abort) this.backgroundAbort = undefined;
      this.busy = false;
      setTaskActive("panel", this.running);
      this.post({ type: "busy", busy: false });
    }
  }

  getTranscript(): string {
    return this.session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? t("用户", "User") : t("助手", "Assistant")}: ${m.content}`)
      .join("\n\n")
      .slice(-60000);
  }

  replaceSessionWithSummary(summary: string): void {
    const compacted = this.systemMessage(
      tf(
        t("（会话已压缩，原 {0} 条消息被替换为以下摘要）\n{1}", "(Conversation compacted; the original {0} messages were replaced with the summary below)\n{1}"),
        this.session.messages.length,
        summary
      )
    );
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

  /** 生效的思维强度：优先用户选择，其次 settings 默认（可传快照避免运行中切换污染）。 */
  private effectiveEffort(selection: ModelSelection | undefined = this.selection): string | undefined {
    return selection?.reasoningEffort ?? readDefaultEffort();
  }

  statusLine(): string {
    const sel = this.selection;
    const colon = isZh() ? "：" : ": ";
    const provider = sel?.provider ? providerDisplayName(sel.provider) : t("（DSH 默认）", " (DSH default)");
    const model = sel?.model ?? t("（DSH 默认）", " (DSH default)");
    const effort = this.effectiveEffort() ?? t("未设置", "not set");
    const skills = this.enabledSkills.length ? this.enabledSkills.join(t("、", ", ")) : t("无", "none");
    const sandbox = vscode.workspace.getConfiguration("dsh-harness-vscode").get<string>("permissionMode", "workspace-write");
    const modeInfo = agentModeById(sel?.mode);
    const agentMode = modeInfo ? t(modeInfo.name, modeInfo.nameEn) : t("默认组装", "default composition");
    const usage = this.lastUsage
      ? "\n" +
        t("用量", "Usage") +
        `${colon}${t("输入", "input")} ${fmtNum(this.lastUsage.input)} · ${t("输出", "output")} ${fmtNum(this.lastUsage.output)} · ${t("缓存读", "cache read")} ${fmtNum(this.lastUsage.cacheRead)} · ${t("推理", "reasoning")} ${fmtNum(this.lastUsage.reasoning)} token` +
        (this.lastUsage.cacheRead + this.lastUsage.input > 0
          ? ` · ${t("缓存命中", "cache hit")} ${Math.round((this.lastUsage.cacheRead / (this.lastUsage.cacheRead + this.lastUsage.input)) * 100)}%`
          : "")
      : "";
    return `${t("提供商", "Provider")}${colon}${provider}\n${t("模型", "Model")}${colon}${model}（${t("思维强度", "effort")} ${effort}）\n${t("Agent 模式", "Agent mode")}${colon}${agentMode}\n${t("沙箱模式", "Sandbox")}${colon}${sandbox}\n${t("已启用技能", "Enabled skills")}${colon}${skills}${usage}`;
  }

  /** 在聊天中展示项目长期记忆。 */
  showMemory(): void {
    postMemory(this);
  }

  /** 在编辑器中打开项目记忆文件（不存在则创建；失败给友好提示，不弹原始错误对话框）。 */
  async editMemory(): Promise<void> {
    const file = path.join(this.folder.uri.fsPath, ".dsh", "memory.md");
    try {
      if (!this.memory.exists()) {
        const fs = await import("fs");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(
          tmp,
          t(
            "# 项目长期记忆\n\n在这里记录项目的关键约定、架构决策、常用命令等，DSH 每次任务会自动参考。\n",
            "# Project long-term memory\n\nRecord key conventions, architecture decisions, common commands, etc. DSH references this on every task.\n"
          ),
          "utf8"
        );
        fs.renameSync(tmp, file);
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      // 焦点留在记忆文件上，不要刚打开编辑器又被聊天面板抢走
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(tf(t("无法打开项目记忆文件：{0}", "Cannot open the project memory file: {0}"), message));
    }
  }

  addContextBlock(block: Omit<ContextBlock, "id">): void {
    const full: ContextBlock = { ...block, id: UUID() };
    this.contextBlocks = [...this.contextBlocks, full];
    this.post({ type: "contextChanged", blocks: this.contextBlocks });
    this.reveal();
  }

  /** 用指定的会话/目录/上下文/模型/技能快照组装任务文本（供 executeTask 在 await 前取快照）。 */
  private buildTaskTextFor(
    session: ChatSession,
    folder: vscode.WorkspaceFolder,
    contextBlocks: ContextBlock[],
    selection: ModelSelection | undefined,
    enabledSkills: string[]
  ): string {
    const cfg = vscode.workspace.getConfiguration("dsh-harness-vscode");
    const rawHistory = cfg.get<number>("historyMessages", 20);
    const rawMax = cfg.get<number>("maxMessageChars", 8000);
    // 与 package.json 的 minimum/maximum 对齐，防 settings.json 手填负值/超大值
    const historyN = Number.isFinite(rawHistory) ? Math.min(100, Math.max(0, Math.floor(rawHistory))) : 20;
    const maxChars = Number.isFinite(rawMax) ? Math.min(100000, Math.max(500, Math.floor(rawMax))) : 8000;

    const extraSections: string[] = [];
    const sel = selection;
    if (sel?.provider && sel.model) {
      extraSections.push(
        t("本会话模型配置：提供商 {0}，模型 {1}", "Session model config: provider {0}, model {1}")
          .replace("{0}", sel.provider).replace("{1}", sel.model) +
          (this.effectiveEffort(sel) ? t("，思维强度 {0}", ", effort {0}").replace("{0}", this.effectiveEffort(sel)!) : "")
      );
    }
    const modeInfo = agentModeById(sel?.mode);
    if (modeInfo) {
      extraSections.push(
        t("本会话 Agent 模式：{0}（{1}）", "Session agent mode: {0} ({1})")
          .replace("{0}", t(modeInfo.name, modeInfo.nameEn))
          .replace("{1}", t(modeInfo.description, modeInfo.descriptionEn))
      );
    }
    if (enabledSkills.length > 0) {
      extraSections.push(t("本会话已启用技能：{0}（按需通过技能工具加载）", "Skills enabled in this session: {0} (load on demand via the skill tool)").replace("{0}", enabledSkills.join(t("、", ", "))));
    }

    return buildTaskText(
      folder.uri.fsPath,
      session,
      contextBlocks,
      this.memory,
      historyN,
      maxChars,
      extraSections,
      isZh()
    );
  }

  // ---------------------------------------------------------------- 其它

  cancel(): void {
    if (this.running) {
      this.abort?.abort();
    }
    // 用户主动取消时，后台任务（/compact）也一并终止
    if (this.busy) {
      this.backgroundAbort?.abort();
    }
  }

  private insertCodeFromMessage(messageId: string): void {
    const msg = this.session.messages.find((m) => m.id === messageId);
    if (!msg) return;
    const code = extractCodeForInsert(msg.content);
    if (!code) {
      void vscode.window.showWarningMessage(t("这条回答里没有代码块，无法插入代码。", "This answer has no code block to insert."));
      return;
    }
    insertCodeToEditor(code);
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
        label: b.pathHint ?? tf(t("代码块 {0}（{1}）", "Code block {0} ({1})"), i + 1, b.language || "text"),
        description: b.code.slice(0, 80).replace(/\n/g, " "),
        block: b,
      })),
      { placeHolder: t("选择要应用哪个代码块", "Choose which code block to apply") }
    );
    if (pick) await applyCodeBlock(this.folder.uri.fsPath, pick.block);
  }

  private dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.backgroundAbort?.abort();
    for (const d of this.disposables) {
      d.dispose();
    }
    if (ChatPanel.instance === this) {
      ChatPanel.instance = undefined;
    }
  }
}
