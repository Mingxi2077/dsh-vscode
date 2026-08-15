import * as vscode from "vscode";
import type { ChatMessage } from "./sessionStore";
import type { ContextBlock } from "./chatPanel";
import type { ProjectMemory } from "./memory";
import type { ModelSelection, ProviderInfo } from "./modelSelection";
import {
  CATALOG_PROVIDERS,
  DEEPSEEK_PROVIDER,
  REASONING_EFFORTS,
  apiKeyEnvFor,
  catalogProviderById,
  listModels,
  providerUiName,
  readCustomProviders,
} from "./modelSelection";
import {
  LlmProviderProfile,
  catalogProfile,
  hasProvider,
  readSettingsFile,
  settingsPath,
  writeProviderToSettings,
} from "./settingsEditor";
import { listSkills } from "./skills";
import { AGENT_MODES, AgentModeId } from "./agentModes";
import { t, tf, isZh } from "./i18n";

/** slash 命令需要的最小宿主能力。 */
export interface ChatCommandHost {
  post(message: unknown): void;
  newSession(): void;
  systemMessage(content: string): ChatMessage;
  memory: ProjectMemory;
  contextBlocks: ContextBlock[];
  editMemory(): Promise<void>;
  folderPath: string;
  selection: ModelSelection | undefined;
  setSelection(sel: ModelSelection | undefined): Promise<void>;
  /** 当前会话是否 blank（DSH 规则：Agent 预设只允许在 blank 会话切换）。 */
  canSwitchMode(): boolean;
  /** blank 会话内更新当前会话的预设模式（下个任务生效并锁定）。 */
  setSessionMode(mode: AgentModeId | undefined): void;
  enabledSkills: string[];
  setEnabledSkills(names: string[]): void;
  getEnvSecret(name: string): Promise<string | undefined>;
  setEnvSecret(name: string, value: string): Promise<void>;
  /** 跑一次不落聊天记录的一次性任务（用于 /compact），成功返回文本。 */
  runHeadlessTask(task: string): Promise<string | null>;
  /** 当前会话转录（user/assistant 消息文本），供压缩使用。 */
  getTranscript(): string;
  /** 用压缩摘要替换当前会话历史。 */
  replaceSessionWithSummary(summary: string): void;
  /** 状态行（provider/model/effort/技能/用量）。 */
  statusLine(): string;
}

export const SLASH_HELP_ZH = [
  "/help             显示本帮助",
  "/clear            新建会话（清空当前对话）",
  "/memory           查看项目长期记忆",
  "/edit-memory      在编辑器中打开记忆文件",
  "/remember <内容>  把一条知识记入项目长期记忆",
  "/context          查看当前挂载的上下文",
  "/provider         切换模型提供商（可输入 API Key）",
  "/model            切换模型",
  "/effort           切换思维强度 (off/low/medium/high/max)",
  "/mode             选择 Agent 模式（标准 / PTC / 极简 / 创造）",
  "/skills           选择要启用的技能",
  "/compact          压缩当前会话为摘要（释放上下文）",
  "/status           查看当前配置与用量",
].join("\n");

export const SLASH_HELP_EN = [
  "/help             Show this help",
  "/clear            New session (clear current chat)",
  "/memory           Show project long-term memory",
  "/edit-memory      Open the memory file in the editor",
  "/remember <text>  Add a fact to project long-term memory",
  "/context          Show attached context",
  "/provider         Switch model provider (can input API key)",
  "/model            Switch model",
  "/effort           Switch reasoning effort (off/low/medium/high/max)",
  "/mode             Choose agent mode (Standard / PTC / Minimal / Creator)",
  "/skills           Choose enabled skills",
  "/compact          Compact the session into a summary",
  "/status           Show current config & usage",
].join("\n");

/** 处理聊天输入中的 slash 命令。 */
export function handleSlashCommand(host: ChatCommandHost, raw: string): void {
  const parts = raw.trim().split(/\s+/);
  const cmd = parts[0] ?? "";
  const rest = raw.trim().slice(cmd.length).trim();
  switch (cmd) {
    case "/help":
      host.post({ type: "appendMessage", message: host.systemMessage(t(SLASH_HELP_ZH, SLASH_HELP_EN)) });
      break;
    case "/clear":
      host.newSession();
      break;
    case "/memory":
      postMemory(host);
      break;
    case "/edit-memory":
      void host.editMemory();
      break;
    case "/remember": {
      if (!rest) {
        host.post({
          type: "appendMessage",
          message: host.systemMessage(
            t(
              "用法：/remember <要记住的内容>，例如：/remember 构建命令是 npm run build",
              "Usage: /remember <content>, e.g. /remember build command is npm run build"
            )
          ),
        });
        break;
      }
      host.memory.append(rest);
      host.post({
        type: "appendMessage",
        message: host.systemMessage(tf(t("已记入项目长期记忆：{0}", "Saved to project memory: {0}"), rest)),
      });
      break;
    }
    case "/context": {
      const summary =
        host.contextBlocks.length === 0
          ? t("（当前没有挂载的上下文）", "(no context attached)")
          : host.contextBlocks.map((b) => `- [${b.kind}] ${b.label}`).join("\n");
      host.post({ type: "appendMessage", message: host.systemMessage(tf(t("当前上下文：\n{0}", "Current context:\n{0}"), summary)) });
      break;
    }
    case "/provider":
      void pickProvider(host).catch((e) => reportAsyncError(host, e));
      break;
    case "/model":
      void pickModel(host).catch((e) => reportAsyncError(host, e));
      break;
    case "/effort":
      void pickEffort(host).catch((e) => reportAsyncError(host, e));
      break;
    case "/mode":
      void pickAgentMode(host).catch((e) => reportAsyncError(host, e));
      break;
    case "/skills":
      void pickSkills(host).catch((e) => reportAsyncError(host, e));
      break;
    case "/compact":
      void compactConversation(host).catch((e) => reportAsyncError(host, e));
      break;
    case "/status":
      host.post({ type: "appendMessage", message: host.systemMessage(host.statusLine()) });
      break;
    default:
      host.post({
        type: "appendMessage",
        message: host.systemMessage(tf(t("未知命令「{0}」。支持的命令：\n{1}", "Unknown command \"{0}\". Supported commands:\n{1}"), cmd, t(SLASH_HELP_ZH, SLASH_HELP_EN))),
      });
  }
}

// ---------------------------------------------------------------- 提供商 / 模型 / 强度

/** 异步斜杠命令的兜底错误报告（避免 unhandledRejection）。 */
function reportAsyncError(host: ChatCommandHost, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  host.post({ type: "appendMessage", message: host.systemMessage(tf(t("命令执行出错：{0}", "Command failed: {0}"), message)) });
}

async function pickProvider(host: ChatCommandHost): Promise<void> {
  const raw = readSettingsFile();
  const custom = readCustomProviders();
  const configuredIds = new Set(custom.map((p) => p.id));
  const picks = await vscode.window.showQuickPick(
    [
      // --- 官方内置（填 Key 即用） ---
      { label: t("✨ 官方内置提供商（填 Key 即用）", "✨ Built-in providers (add a key)"), kind: vscode.QuickPickItemKind.Separator },
      ...CATALOG_PICKS(raw, configuredIds),
      // --- 已配置 ---
      { label: t("🛠 已配置的提供商", "🛠 Configured providers"), kind: vscode.QuickPickItemKind.Separator },
      { label: providerUiName(DEEPSEEK_PROVIDER), description: DEEPSEEK_PROVIDER.id, detail: t("DSH 出厂自带，无需配置", "Built into DSH, nothing to configure"), providerId: DEEPSEEK_PROVIDER.id },
      ...custom.map((p) => ({
        label: p.displayName || p.id,
        description: p.id,
        detail: p.apiKeyEnv ? `API Key：${p.apiKeyEnv}` : undefined,
        providerId: p.id,
      })),
      // --- 手动添加 ---
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(add) " + t("手动添加自定义提供商…", "Add custom provider…"), description: t("自建网关 / 中转（OpenAI 兼容或 Anthropic 协议）", "Self-hosted gateway / relay (OpenAI-compatible or Anthropic protocol)"), providerId: "__add__" },
    ],
    { placeHolder: t("选择模型提供商", "Choose a model provider") }
  );
  if (!picks || !picks.providerId) return;

  if (picks.providerId === "__add__") {
    await addCustomProvider(host);
    return;
  }
  if (picks.providerId === DEEPSEEK_PROVIDER.id) {
    await selectProvider(host, DEEPSEEK_PROVIDER);
    return;
  }
  const cat = catalogProviderById(picks.providerId);
  if (cat) {
    await selectProvider(host, cat);
    return;
  }
  const cp = custom.find((p) => p.id === picks.providerId);
  if (cp) await selectProvider(host, cp);
}

/** 官方内置提供商的可选项（未配置的带"一键接入"标识，已配置的标注）。 */
function CATALOG_PICKS(raw: string, configuredIds: Set<string>) {
  return CATALOG_PROVIDERS.map((p) => {
    const configured = configuredIds.has(p.id) || hasProvider(raw, p.id);
    const name = providerUiName(p);
    return {
      label: configured ? name : `${name}（${t("一键接入", "one-click")}）`,
      description: p.id,
      detail: `${p.apiKeyEnv ?? t("无需 Key", "no key needed")}${configured ? " · " + t("已配置", "configured") : ""}${p.note ? ` · ${t(p.note, p.noteEn ?? p.note)}` : ""}`,
      providerId: p.id,
    };
  });
}

/** 选择一个 provider：确保已写入 settings.yaml + 输入 API Key + 切换模型选择。 */
async function selectProvider(host: ChatCommandHost, provider: ProviderInfo): Promise<void> {
  const isCatalog = !!catalogProviderById(provider.id);
  const displayName = providerUiName(provider);
  const raw = readSettingsFile();
  const needWrite = !hasProvider(raw, provider.id);
  if (needWrite && isCatalog && provider.apiKeyEnv) {
    const go = await vscode.window.showInformationMessage(
      tf(
        t(
          "将把 {1}（{2}）写入 {0} 的 llm-pi-ai.providers（只需 apiKeyEnv，模型由 DSH 目录提供）。继续？",
          "Write {1} ({2}) into llm-pi-ai.providers in {0} (apiKeyEnv only; models come from the DSH catalog). Continue?"
        ),
        settingsPath(),
        displayName,
        provider.id
      ),
      { modal: true },
      t("继续", "Continue")
    );
    if (!go) return;
    const res = writeProviderToSettings(catalogProfile(provider.id, provider.apiKeyEnv, provider.displayName));
    if (!res.ok) {
      host.post({ type: "appendMessage", message: host.systemMessage(res.message) });
      return;
    }
  }

  // API Key：先看系统密钥链，没有则提示输入
  const envName = apiKeyEnvFor(provider.id);
  if (envName) {
    const existing = await host.getEnvSecret(envName);
    const act = await vscode.window.showQuickPick(
      [
        { label: t("设置 API Key", "Set API Key"), description: existing ? t("当前已配置（保存在系统密钥链）", "already set (system keychain)") : t("尚未配置", "not set") },
        { label: t("跳过（使用环境变量 / DSH 凭证）", "Skip (use env var / DSH credentials)"), description: "" },
      ],
      { placeHolder: `${displayName} ` + t("需要 API Key（{0}）", "needs an API Key ({0})").replace("{0}", envName) }
    );
    if (act?.label.startsWith(t("设置", "Set"))) {
      const key = await vscode.window.showInputBox({
        prompt: t("输入 API Key（{0}）", "Enter API Key ({0})").replace("{0}", envName),
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v && v.trim().length > 0 ? undefined : t("不能为空", "cannot be empty")),
      });
      if (key) await host.setEnvSecret(envName, key.trim());
    }
  }

  // 切换提供商时不要沿用旧提供商的 model id（例如 openai 的 gpt-5.4 对 anthropic 无效）
  const sel: ModelSelection = {
    provider: provider.id,
    model: "",
    reasoningEffort: host.selection?.reasoningEffort,
    mode: host.selection?.mode,
  };
  await host.setSelection(sel);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(
      tf(t("提供商已切换：{0}（{1}）。下一步用 /model 选模型。", "Provider switched to {0} ({1}). Next, use /model to pick a model."), displayName, provider.id)
    ),
  });
}

/** 手动添加自定义提供商向导（自建网关 / 中转）。 */
async function addCustomProvider(host: ChatCommandHost): Promise<void> {
  const displayName = await vscode.window.showInputBox({
    prompt: t("自定义提供商显示名称（如：LMU AI GPT Relay）", "Custom provider display name (e.g. LMU AI GPT Relay)"),
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim().length > 0 ? undefined : t("不能为空", "cannot be empty")),
  });
  if (!displayName) return;

  const id = await vscode.window.showInputBox({
    prompt: t("提供商 id（小写字母数字，如 lmuai）", "Provider id (lowercase alphanumeric, e.g. lmuai)"),
    ignoreFocusOut: true,
    value: displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    validateInput: (v) => (v && /^[a-z0-9][a-z0-9_-]*$/.test(v.trim()) ? undefined : t("需小写字母数字开头，可含 - _", "must start with lowercase alphanumeric; may contain - _")),
  });
  if (!id) return;

  const api = await vscode.window.showQuickPick(
    [
      { label: t("OpenAI 兼容（openai-completions）", "OpenAI-compatible (openai-completions)"), description: t("大多数中转/网关", "Most relays/gateways"), api: "openai-completions" },
      { label: t("Anthropic 协议（anthropic-messages）", "Anthropic protocol (anthropic-messages)"), description: t("Claude 直连/兼容网关", "Claude direct / compatible gateways"), api: "anthropic-messages" },
    ],
    { placeHolder: t("选择 API 协议", "Choose API protocol") }
  );
  if (!api) return;

  const baseURL = await vscode.window.showInputBox({
    prompt: t("Base URL（如 https://api.lmuai.com/v1）", "Base URL (e.g. https://api.lmuai.com/v1)"),
    ignoreFocusOut: true,
    placeHolder: "https://…",
    validateInput: (v) => {
      const s = (v ?? "").trim();
      if (!s) return t("不能为空", "cannot be empty");
      if (!/^https?:\/\//i.test(s)) return t("必须以 http:// 或 https:// 开头", "Must start with http:// or https://");
      return undefined;
    },
  });
  if (!baseURL) return;

  const envName = await vscode.window.showInputBox({
    prompt: t("API Key 环境变量名（如 LMUAI_API_KEY）", "API key env var name (e.g. LMUAI_API_KEY)"),
    ignoreFocusOut: true,
    value: (id.toUpperCase() + "_API_KEY").replace(/-/g, "_"),
    validateInput: (v) => (v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? undefined : t("需合法环境变量名", "must be a valid env var name")),
  });
  if (!envName) return;

  // 可选：预填模型
  const modelsRaw = await vscode.window.showInputBox({
    prompt: t("模型 id 列表（逗号分隔，可留空后用 /model 手动输入）", "Model id list (comma-separated; leave empty to pick via /model later)"),
    ignoreFocusOut: true,
    placeHolder: "gpt-5.5, gpt-5.4",
  });
  const models = (modelsRaw ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => ({ id: m }));

  const profile: LlmProviderProfile = { id: id.trim(), displayName: displayName.trim(), apiKeyEnv: envName.trim(), api: api.api, baseURL: baseURL.trim(), models };
  const res = writeProviderToSettings(profile);
  if (!res.ok) {
    host.post({ type: "appendMessage", message: host.systemMessage(res.message) });
    return;
  }
  host.post({ type: "appendMessage", message: host.systemMessage(tf(t("已添加自定义提供商 {0}（{1}）", "Added custom provider {0} ({1})"), displayName, res.message)) });

  // 请求输入 API Key（存系统密钥链）
  const act = await vscode.window.showQuickPick(
    [
      { label: t("设置 API Key", "Set API key"), description: t("保存在系统密钥链", "Saved in the system keychain"), action: "set-key" },
      { label: t("跳过", "Skip"), description: t("使用环境变量 / DSH 凭证", "Use env var / DSH credentials"), action: "skip" },
    ],
    { placeHolder: `${displayName} ${t("的 API Key", "API key")}（${envName.trim()}）` }
  );
  if (act?.action === "set-key") {
    const key = await vscode.window.showInputBox({
      prompt: `API Key（${envName.trim()}）`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : t("不能为空", "cannot be empty")),
    });
    if (key) await host.setEnvSecret(envName.trim(), key.trim());
  }

  const sel: ModelSelection = {
    provider: id.trim(),
    model: models[0]?.id ?? "",
    reasoningEffort: host.selection?.reasoningEffort,
    mode: host.selection?.mode,
  };
  await host.setSelection(sel);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(tf(t("提供商已切换：{0}（{1}）。用 /model 选模型。", "Provider switched: {0} ({1}). Use /model to pick a model."), displayName, id.trim())),
  });
}

async function pickModel(host: ChatCommandHost): Promise<void> {
  const providerId = host.selection?.provider ?? DEEPSEEK_PROVIDER.id;
  const models = listModels(providerId);
  if (models.length === 0) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(tf(t("提供商 {0} 没有可列举的模型，可手动输入模型名。", "Provider {0} has no enumerable models; you can type a model name manually."), providerId)),
    });
  }
  const input = await vscode.window.showQuickPick(
    [
      ...models.map((m) => ({ label: m, description: undefined as string | undefined, model: m })),
      { label: "$(add) " + t("手动输入模型名…", "Type a model name…"), description: undefined, model: undefined },
    ],
    { placeHolder: tf(t("选择模型（当前提供商 {0}）", "Pick a model (current provider {0})"), providerId) }
  );
  let model = input?.model;
  if (input && input.model === undefined) {
    model = await vscode.window.showInputBox({
      prompt: t("输入模型名", "Enter model name"),
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : t("不能为空", "cannot be empty")),
    });
  }
  if (!model) return;
  const modelId = model.trim();
  if (!modelId) return;
  await host.setSelection({ ...host.selection, provider: providerId, model: modelId });
  host.post({ type: "appendMessage", message: host.systemMessage(tf(t("模型已切换：{0}", "Model switched: {0}"), modelId)) });
}

async function pickEffort(host: ChatCommandHost): Promise<void> {
  const current = host.selection?.reasoningEffort;
  const pick = await vscode.window.showQuickPick(
    REASONING_EFFORTS.map((e) => ({
      label: e,
      description: e === current ? t("当前", "current") : undefined,
      effort: e,
    })),
    { placeHolder: t("选择思维强度", "Choose reasoning effort") }
  );
  if (!pick) return;
  const hasModel = !!host.selection?.model;
  await host.setSelection({ ...host.selection, provider: host.selection?.provider ?? DEEPSEEK_PROVIDER.id, model: host.selection?.model ?? "", reasoningEffort: pick.effort });
  host.post({
    type: "appendMessage",
    message: host.systemMessage(
      tf(t("思维强度已切换：{0}", "Reasoning effort switched: {0}"), pick.effort) +
        (hasModel ? "" : " " + t("（尚未选择模型，需先 /model 才会随任务生效）", "(no model selected yet; run /model first for it to take effect)"))
    ),
  });
}

// ---------------------------------------------------------------- Agent 模式

async function pickAgentMode(host: ChatCommandHost): Promise<void> {
  // DSH 原生规则：会话一旦开始，Agent 预设固定；扩展复刻同样语义
  if (!host.canSwitchMode()) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(
        t(
          "当前会话已经开始，Agent 模式已固定（DSH 规则）。请用 /clear 新建会话后再切换模式。",
          "This session has already started, so its agent mode is fixed (DSH rule). Run /clear to start a new session, then switch modes."
        )
      ),
    });
    return;
  }
  const current = host.selection?.mode;
  const items: (vscode.QuickPickItem & { mode?: AgentModeId })[] = [
    { label: t("默认组装", "Default composition"), description: t("跟随 headless 默认插件组装", "Use the default headless composition"), mode: undefined },
    ...AGENT_MODES.map((m) => ({
      label: t(m.name, m.nameEn),
      description: current === m.id ? t("当前", "current") : undefined,
      detail: t(m.description, m.descriptionEn) + (m.warning ? ` ⚠ ${t(m.warning, m.warningEn ?? m.warning)}` : ""),
      mode: m.id,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: t("选择 Agent 模式（标准 / PTC / 极简 / 创造）", "Choose an agent mode (Standard / PTC / Minimal / Creator)"),
    matchOnDetail: true,
  });
  if (!pick) return;

  const selected = pick.mode;
  const info = selected ? AGENT_MODES.find((m) => m.id === selected) : undefined;
  if (info?.warning) {
    const go = await vscode.window.showWarningMessage(
      t(`启用「${info.name}」？${info.warning}`, `Enable "${info.nameEn}"? ${info.warningEn ?? info.warning}`),
      { modal: true },
      t("继续", "Continue")
    );
    if (go !== t("继续", "Continue")) return;
  }

  await host.setSelection({
    provider: host.selection?.provider ?? DEEPSEEK_PROVIDER.id,
    model: host.selection?.model ?? "",
    reasoningEffort: host.selection?.reasoningEffort,
    mode: selected,
  });
  // 当前还是 blank 会话：同步更新本会话的创建预设，首个任务开始后锁定
  host.setSessionMode(selected);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(
      selected
        ? tf(
            t("Agent 模式已切换：{0}（{1}）。将在下个任务开始时固定到本会话。", "Agent mode switched to {0} ({1}). It will be fixed to this session when the next task starts."),
            info ? t(info.name, info.nameEn) : selected,
            info ? t(info.description, info.descriptionEn) : ""
          )
        : t("Agent 模式已恢复为默认组装。", "Agent mode reset to the default composition.")
    ),
  });
}

// ---------------------------------------------------------------- 技能

async function pickSkills(host: ChatCommandHost): Promise<void> {
  const skills = listSkills(host.folderPath);
  if (skills.length === 0) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(
        t(
          "当前没有可用技能。技能目录：~/.dsh/skills/ 或 <项目>/.dsh/skills/，每个技能一个子目录，内含 SKILL.md（frontmatter: name/description）。",
          "No skills available. Skill directories: ~/.dsh/skills/ or <project>/.dsh/skills/, one subdirectory per skill containing a SKILL.md (frontmatter: name/description)."
        )
      ),
    });
    return;
  }
  const picks = await vscode.window.showQuickPick(
    skills.map((s) => ({
      label: s.name,
      description: s.description,
      detail: s.root,
      picked: host.enabledSkills.includes(s.name),
      skill: s,
    })),
    { canPickMany: true, placeHolder: t("选择要启用的技能（可多选）", "Choose skills to enable (multi-select)") }
  );
  if (!picks) return;
  host.setEnabledSkills(picks.map((p) => p.skill.name));
  host.post({
    type: "appendMessage",
    message: host.systemMessage(
      picks.length > 0 ? tf(t("已启用技能：{0}", "Skills enabled: {0}"), picks.map((p) => p.skill.name).join(", ")) : t("已清空技能选择", "Skill selection cleared")
    ),
  });
}

// ---------------------------------------------------------------- 压缩

async function compactConversation(host: ChatCommandHost): Promise<void> {
  const transcript = host.getTranscript().trim();
  if (!transcript) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(t("当前会话还没有可压缩的对话内容。", "There is no conversation to compact in this session yet.")),
    });
    return;
  }
  host.post({ type: "appendMessage", message: host.systemMessage(t("正在压缩会话…（由 DSH 生成摘要）", "Compacting conversation… (summary generated by DSH)")) });
  const task = isZh()
    ? "你是会话压缩器。把下面的对话压缩成一份结构化摘要（中文，300-500 字），必须保留：\n" +
      "1) 任务目标与当前进展；2) 已确认的关键决策和结论；3) 用户偏好与约束；4) 待办事项；5) 重要的代码/命令/文件路径。\n" +
      "只输出摘要本身，不要额外说明。\n\n--- 对话记录 ---\n" + transcript
    : "You are a conversation compactor. Compress the conversation below into a structured summary (English, 300-500 words) that keeps:\n" +
      "1) task goal and current progress; 2) confirmed key decisions and conclusions; 3) user preferences and constraints; 4) open todos; 5) important code/commands/file paths.\n" +
      "Output only the summary, no extra explanation.\n\n--- Conversation ---\n" + transcript;
  const summary = await host.runHeadlessTask(task);
  if (!summary) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(t("压缩失败（dsh 未返回结果）。可重试或继续使用原会话。", "Compaction failed (dsh returned no result). Retry or continue with the original conversation.")),
    });
    return;
  }
  host.replaceSessionWithSummary(summary);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(tf(t("会话已压缩，历史替换为摘要：\n{0}", "Conversation compacted; history replaced with summary:\n{0}"), summary)),
  });
}

/** 在聊天中展示项目长期记忆。 */
export function postMemory(host: ChatCommandHost): void {
  const content = host.memory.read().trim();
  const body = content
    ? content.slice(0, 4000) + (content.length > 4000 ? t("\n…(内容过长，仅显示开头)", "\n…(too long, showing the beginning only)") : "")
    : t("（项目长期记忆为空，可用 /remember 添加）", "(project memory is empty; use /remember to add)");
  host.post({ type: "appendMessage", message: host.systemMessage(t("项目长期记忆：\n{0}", "Project long-term memory:\n{0}").replace("{0}", body)) });
}
