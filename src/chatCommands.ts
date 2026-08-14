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
  readCustomProviders,
} from "./modelSelection";
import {
  LlmProviderProfile,
  catalogProfile,
  hasProvider,
  readSettingsFile,
  writeProviderToSettings,
} from "./settingsEditor";
import { listSkills } from "./skills";
import { t, tf } from "./i18n";

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
      void pickProvider(host);
      break;
    case "/model":
      void pickModel(host);
      break;
    case "/effort":
      void pickEffort(host);
      break;
    case "/skills":
      void pickSkills(host);
      break;
    case "/compact":
      void compactConversation(host);
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

async function pickProvider(host: ChatCommandHost): Promise<void> {
  const raw = readSettingsFile();
  const custom = readCustomProviders();
  const configuredIds = new Set(custom.map((p) => p.id));
  const picks = await vscode.window.showQuickPick(
    [
      // --- 官方内置（填 Key 即用） ---
      { label: "✨ 官方内置提供商（填 Key 即用）", kind: vscode.QuickPickItemKind.Separator },
      ...CATALOG_PICKS(raw, configuredIds),
      // --- 已配置 ---
      { label: "🛠 已配置的提供商", kind: vscode.QuickPickItemKind.Separator },
      { label: DEEPSEEK_PROVIDER.displayName, description: DEEPSEEK_PROVIDER.id, detail: "DSH 出厂自带，无需配置", providerId: DEEPSEEK_PROVIDER.id },
      ...custom.map((p) => ({
        label: p.displayName || p.id,
        description: p.id,
        detail: p.apiKeyEnv ? `API Key：${p.apiKeyEnv}` : undefined,
        providerId: p.id,
      })),
      // --- 手动添加 ---
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(add) 手动添加自定义提供商…", description: "自建网关 / 中转（OpenAI 兼容或 Anthropic 协议）", providerId: "__add__" },
    ],
    { placeHolder: "选择模型提供商" }
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
    return {
      label: configured ? p.displayName : `${p.displayName}（一键接入）`,
      description: p.id,
      detail: `${p.apiKeyEnv ?? "无需 Key"}${configured ? " · 已配置" : ""}${p.note ? ` · ${p.note}` : ""}`,
      providerId: p.id,
    };
  });
}

/** 选择一个 provider：确保已写入 settings.yaml + 输入 API Key + 切换模型选择。 */
async function selectProvider(host: ChatCommandHost, provider: ProviderInfo): Promise<void> {
  const isCatalog = !!catalogProviderById(provider.id);
  const raw = readSettingsFile();
  const needWrite = !hasProvider(raw, provider.id);
  if (needWrite && isCatalog && provider.apiKeyEnv) {
    const go = await vscode.window.showInformationMessage(
      `将把 ${provider.displayName}（${provider.id}）写入 ~/.dsh/settings.yaml 的 llm-pi-ai.providers（只需 apiKeyEnv，模型由 DSH 目录提供）。继续？`,
      { modal: true },
      "继续"
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
        { label: "设置 API Key", description: existing ? "当前已配置（保存在系统密钥链）" : "尚未配置" },
        { label: "跳过（使用环境变量 / DSH 凭证）", description: "" },
      ],
      { placeHolder: `${provider.displayName} 需要 API Key（${envName}）` }
    );
    if (act?.label.startsWith("设置")) {
      const key = await vscode.window.showInputBox({
        prompt: `输入 API Key（${envName}）`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => (v && v.trim().length > 0 ? undefined : "不能为空"),
      });
      if (key) await host.setEnvSecret(envName, key.trim());
    }
  }

  const sel: ModelSelection = {
    provider: provider.id,
    model: host.selection?.model ?? "",
    reasoningEffort: host.selection?.reasoningEffort,
  };
  await host.setSelection(sel);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(
      `提供商已切换：${provider.displayName}（${provider.id}）。下一步用 /model 选模型。`
    ),
  });
}

/** 手动添加自定义提供商向导（自建网关 / 中转）。 */
async function addCustomProvider(host: ChatCommandHost): Promise<void> {
  const displayName = await vscode.window.showInputBox({
    prompt: "自定义提供商显示名称（如：LMU AI GPT Relay）",
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim().length > 0 ? undefined : "不能为空"),
  });
  if (!displayName) return;

  const id = await vscode.window.showInputBox({
    prompt: "提供商 id（小写字母数字，如 lmuai）",
    ignoreFocusOut: true,
    value: displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    validateInput: (v) => (v && /^[a-z0-9][a-z0-9_-]*$/.test(v.trim()) ? undefined : "需小写字母数字开头，可含 - _"),
  });
  if (!id) return;

  const api = await vscode.window.showQuickPick(
    [
      { label: "OpenAI 兼容（openai-completions）", description: "大多数中转/网关", api: "openai-completions" },
      { label: "Anthropic 协议（anthropic-messages）", description: "Claude 直连/兼容网关", api: "anthropic-messages" },
    ],
    { placeHolder: "选择 API 协议" }
  );
  if (!api) return;

  const baseURL = await vscode.window.showInputBox({
    prompt: "Base URL（如 https://api.lmuai.com/v1）",
    ignoreFocusOut: true,
    placeHolder: "https://…",
    validateInput: (v) => (v && v.trim().length > 0 ? undefined : "不能为空"),
  });
  if (!baseURL) return;

  const envName = await vscode.window.showInputBox({
    prompt: "API Key 环境变量名（如 LMUAI_API_KEY）",
    ignoreFocusOut: true,
    value: (id.toUpperCase() + "_API_KEY").replace(/-/g, "_"),
    validateInput: (v) => (v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()) ? undefined : "需合法环境变量名"),
  });
  if (!envName) return;

  // 可选：预填模型
  const modelsRaw = await vscode.window.showInputBox({
    prompt: "模型 id 列表（逗号分隔，可留空后用 /model 手动输入）",
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
  host.post({ type: "appendMessage", message: host.systemMessage(`已添加自定义提供商 ${displayName}（${res.message}）`) });

  // 请求输入 API Key（存系统密钥链）
  const act = await vscode.window.showQuickPick(
    [
      { label: "设置 API Key", description: "保存在系统密钥链" },
      { label: "跳过", description: "使用环境变量 / DSH 凭证" },
    ],
    { placeHolder: `${displayName} 的 API Key（${envName.trim()}）` }
  );
  if (act?.label.startsWith("设置")) {
    const key = await vscode.window.showInputBox({
      prompt: `输入 API Key（${envName.trim()}）`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "不能为空"),
    });
    if (key) await host.setEnvSecret(envName.trim(), key.trim());
  }

  const sel: ModelSelection = {
    provider: id.trim(),
    model: models[0]?.id ?? "",
    reasoningEffort: host.selection?.reasoningEffort,
  };
  await host.setSelection(sel);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(`提供商已切换：${displayName}（${id.trim()}）。用 /model 选模型。`),
  });
}

async function pickModel(host: ChatCommandHost): Promise<void> {
  const providerId = host.selection?.provider ?? DEEPSEEK_PROVIDER.id;
  const models = listModels(providerId);
  if (models.length === 0) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(`提供商 ${providerId} 没有可列举的模型，可手动输入模型名。`),
    });
  }
  const input = await vscode.window.showQuickPick(
    [
      ...models.map((m) => ({ label: m, description: undefined as string | undefined, model: m })),
      { label: "$(add) 手动输入模型名…", description: undefined, model: undefined },
    ],
    { placeHolder: `选择模型（当前提供商 ${providerId}）` }
  );
  let model = input?.model;
  if (input && input.model === undefined) {
    model = await vscode.window.showInputBox({
      prompt: "输入模型名",
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.trim().length > 0 ? undefined : "不能为空"),
    });
  }
  if (!model) return;
  await host.setSelection({ ...host.selection, provider: providerId, model });
  host.post({ type: "appendMessage", message: host.systemMessage(`模型已切换：${model}`) });
}

async function pickEffort(host: ChatCommandHost): Promise<void> {
  const current = host.selection?.reasoningEffort;
  const pick = await vscode.window.showQuickPick(
    REASONING_EFFORTS.map((e) => ({
      label: e,
      description: e === current ? "当前" : undefined,
      effort: e,
    })),
    { placeHolder: "选择思维强度" }
  );
  if (!pick) return;
  await host.setSelection({ ...host.selection, provider: host.selection?.provider ?? DEEPSEEK_PROVIDER.id, model: host.selection?.model ?? "", reasoningEffort: pick.effort });
  host.post({ type: "appendMessage", message: host.systemMessage(`思维强度已切换：${pick.effort}`) });
}

// ---------------------------------------------------------------- 技能

async function pickSkills(host: ChatCommandHost): Promise<void> {
  const skills = listSkills(host.folderPath);
  if (skills.length === 0) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage(
        "当前没有可用技能。技能目录：~/.dsh/skills/ 或 <项目>/.dsh/skills/，每个技能一个子目录，内含 SKILL.md（frontmatter: name/description）。"
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
    { canPickMany: true, placeHolder: "选择要启用的技能（可多选）" }
  );
  if (!picks) return;
  host.setEnabledSkills(picks.map((p) => p.skill.name));
  host.post({
    type: "appendMessage",
    message: host.systemMessage(
      picks.length > 0 ? `已启用技能：${picks.map((p) => p.skill.name).join("、")}` : "已清空技能选择"
    ),
  });
}

// ---------------------------------------------------------------- 压缩

async function compactConversation(host: ChatCommandHost): Promise<void> {
  host.post({ type: "appendMessage", message: host.systemMessage("正在压缩会话…（由 DSH 生成摘要）") });
  const task =
    "你是会话压缩器。把下面的对话压缩成一份结构化摘要（中文，300-500 字），必须保留：\n" +
    "1) 任务目标与当前进展；2) 已确认的关键决策和结论；3) 用户偏好与约束；4) 待办事项；5) 重要的代码/命令/文件路径。\n" +
    "只输出摘要本身，不要额外说明。\n\n--- 对话记录 ---\n" + host.getTranscript();
  const summary = await host.runHeadlessTask(task);
  if (!summary) {
    host.post({
      type: "appendMessage",
      message: host.systemMessage("压缩失败（dsh 未返回结果）。可重试或继续使用原会话。"),
    });
    return;
  }
  host.replaceSessionWithSummary(summary);
  host.post({
    type: "appendMessage",
    message: host.systemMessage(`会话已压缩，历史替换为摘要：\n${summary}`),
  });
}

/** 在聊天中展示项目长期记忆。 */
export function postMemory(host: ChatCommandHost): void {
  const content = host.memory.read().trim();
  const body = content
    ? content.slice(0, 4000) + (content.length > 4000 ? "\n…(内容过长，仅显示开头)" : "")
    : "（项目长期记忆为空，可用 /remember 添加）";
  host.post({ type: "appendMessage", message: host.systemMessage(`项目长期记忆：\n${body}`) });
}
