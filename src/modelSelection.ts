import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 用户为当前工作区选择的模型配置（provider/model/思维强度）。 */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 一个可用的提供商。 */
export interface ProviderInfo {
  id: string;
  displayName: string;
  /** 该提供商读取 API Key 的环境变量名（如 DEEPSEEK_API_KEY）。 */
  apiKeyEnv?: string;
  /** 该提供商是否是 DSH/pi-ai 内置 catalog provider（只需 apiKeyEnv 即用）。 */
  catalog?: boolean;
  /** 内置 provider 的代表性模型 id 清单（用于 /model 快速选择；DSH 目录是权威）。 */
  models?: string[];
  /** 需要额外说明的接入方式（如 OAuth / 特殊 env）。 */
  note?: string;
}

/** 内置 deepseek-official 提供商（DSH 出厂自带，无需配置）。 */
export const DEEPSEEK_PROVIDER: ProviderInfo = {
  id: "deepseek-official",
  displayName: "DeepSeek 官方（内置）",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

export const DEEPSEEK_MODELS = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"];

export const REASONING_EFFORTS = ["off", "low", "medium", "high", "max"];

/**
 * DSH/pi-ai 内置 catalog 提供商精选清单（官方更新模型时 DSH 目录自动跟随，
 * 这里只提供 /model 的快速选择；catalog route 配置不写 models，避免过时）。
 * apiKeyEnv 与 pi-ai 的 getApiKeyEnvVars 映射保持一致。
 */
export const CATALOG_PROVIDERS: ProviderInfo[] = [
  { id: "openai", displayName: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", catalog: true,
    models: ["gpt-5.4", "gpt-5.2", "gpt-5", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "o4-mini"] },
  { id: "anthropic", displayName: "Anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", catalog: true,
    models: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  { id: "google", displayName: "Google Gemini", apiKeyEnv: "GEMINI_API_KEY", catalog: true,
    models: ["gemini-3.5-flash", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] },
  { id: "mistral", displayName: "Mistral", apiKeyEnv: "MISTRAL_API_KEY", catalog: true,
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest"] },
  { id: "groq", displayName: "Groq", apiKeyEnv: "GROQ_API_KEY", catalog: true,
    models: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"] },
  { id: "openrouter", displayName: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", catalog: true,
    models: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-3.5-flash", "deepseek/deepseek-v4-flash"] },
  { id: "xai", displayName: "xAI (Grok)", apiKeyEnv: "XAI_API_KEY", catalog: true,
    models: ["grok-4.5", "grok-4.3"] },
  { id: "together", displayName: "Together AI", apiKeyEnv: "TOGETHER_API_KEY", catalog: true,
    models: ["deepseek-ai/DeepSeek-V4-Pro", "Qwen/Qwen3.7-Max", "meta-llama/Llama-3.3-70B-Instruct-Turbo"] },
  { id: "cerebras", displayName: "Cerebras", apiKeyEnv: "CEREBRAS_API_KEY", catalog: true,
    models: [] },
  { id: "nvidia", displayName: "NVIDIA NIM", apiKeyEnv: "NVIDIA_API_KEY", catalog: true,
    models: [] },
  { id: "moonshotai", displayName: "Moonshot AI (Kimi)", apiKeyEnv: "MOONSHOT_API_KEY", catalog: true,
    models: ["kimi-k2.7-code", "kimi-k2"] },
  { id: "minimax", displayName: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY", catalog: true,
    models: ["MiniMax-M2.7"] },
  { id: "huggingface", displayName: "Hugging Face", apiKeyEnv: "HF_TOKEN", catalog: true,
    models: [] },
  { id: "fireworks", displayName: "Fireworks AI", apiKeyEnv: "FIREWORKS_API_KEY", catalog: true,
    models: [] },
  { id: "deepseek", displayName: "DeepSeek (catalog)", apiKeyEnv: "DEEPSEEK_API_KEY", catalog: true,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { id: "github-copilot", displayName: "GitHub Copilot", apiKeyEnv: "COPILOT_GITHUB_TOKEN", catalog: true,
    models: [], note: "需 GitHub Copilot 订阅 token（fine-grained 含 Copilot 权限）" },
];

/** 查找内置 catalog provider（按 id）。 */
export function catalogProviderById(id: string): ProviderInfo | undefined {
  return CATALOG_PROVIDERS.find((p) => p.id === id);
}

/** 某个 provider 是否 DSH 内置 catalog（无需手写 baseURL/协议）。 */
export function isCatalogProvider(id: string): boolean {
  return !!catalogProviderById(id);
}

/** 友好显示名：catalog 用内置 displayName，自定义用 settings 里的，默认回退 id。 */
export function providerDisplayName(providerId: string, settingsPath = defaultSettingsPath()): string {
  if (providerId === DEEPSEEK_PROVIDER.id) return DEEPSEEK_PROVIDER.displayName;
  const cat = catalogProviderById(providerId);
  if (cat) return cat.displayName;
  const cp = readCustomProviders(settingsPath).find((p) => p.id === providerId);
  return cp?.displayName || providerId;
}

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), ".dsh", "settings.yaml");
}

/** 从 settings.yaml 读取 llm-pi-ai.providers（用户自配提供商）。解析失败返回空数组。 */
export function readCustomProviders(settingsPath = defaultSettingsPath()): ProviderInfo[] {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return [];
  }
  const providers: ProviderInfo[] = [];
  const lines = raw.split(/\r?\n/);
  let inPi = false;
  let current: ProviderInfo | undefined;
  for (const line of lines) {
    const indent = (line.match(/^ */)?.[0].length ?? 0);
    const content = line.trim();
    if (!inPi) {
      if (content === "llm-pi-ai:") inPi = true;
      continue;
    }
    if (indent === 0 && content) break; // 离开 llm-pi-ai 块
    if (content === "providers:" || content.startsWith("#") || content === "") continue;
    if (indent === 4 && /^[A-Za-z0-9_-]+:$/.test(content)) {
      if (current) providers.push(current);
      current = { id: content.slice(0, -1), displayName: content.slice(0, -1) };
      continue;
    }
    if (current && indent === 6) {
      const dm = content.match(/^displayName:\s*(.+)$/);
      if (dm) current.displayName = dm[1].trim().replace(/^["']|["']$/g, "");
      const km = content.match(/^apiKeyEnv:\s*(\S+)\s*$/);
      if (km) current.apiKeyEnv = km[1];
    }
  }
  if (current) providers.push(current);
  return providers;
}

/** 某提供商的模型列表。内置 deepseek-official 用固定清单；catalog provider 用精选清单；
 * 手写自定义 provider 从 settings.yaml 的 models 读取。 */
export function listModels(providerId: string, settingsPath = defaultSettingsPath()): string[] {
  if (providerId === DEEPSEEK_PROVIDER.id) return [...DEEPSEEK_MODELS];
  const cat = catalogProviderById(providerId);
  if (cat?.catalog) return [...(cat.models ?? [])];
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  let inProvider = false;
  const models: string[] = [];
  for (const line of lines) {
    const indent = (line.match(/^ */)?.[0].length ?? 0);
    const content = line.trim();
    if (!inProvider) {
      if (indent === 4 && content === `${providerId}:`) inProvider = true;
      continue;
    }
    if (indent === 4 && content && content !== "models:") break; // 下一个提供商或离开
    const nm = content.match(/^- name:\s*(\S+)\s*$/);
    if (nm) models.push(nm[1]);
  }
  return models;
}

/** 当前默认思维强度（settings.yaml agent-default-model.reasoningEffort）。 */
export function readDefaultEffort(settingsPath = defaultSettingsPath()): string | undefined {
  return readDefaultSelection(settingsPath)?.reasoningEffort;
}

/** 当前默认模型（settings.yaml agent-default-model）。 */
export function readDefaultSelection(settingsPath = defaultSettingsPath()): ModelSelection | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split(/\r?\n/);
  let inBlock = false;
  const sel: Partial<ModelSelection> = {};
  for (const line of lines) {
    const indent = (line.match(/^ */)?.[0].length ?? 0);
    const content = line.trim();
    if (!inBlock) {
      if (content === "agent-default-model:") inBlock = true;
      continue;
    }
    if (indent === 0 && content) break;
    const pm = content.match(/^provider:\s*(\S+)\s*$/);
    if (pm) sel.provider = pm[1];
    const mm = content.match(/^model:\s*(\S+)\s*$/);
    if (mm) sel.model = mm[1];
    const em = content.match(/^reasoningEffort:\s*(\S+)\s*$/);
    if (em) sel.reasoningEffort = em[1];
  }
  return sel.provider && sel.model ? (sel as ModelSelection) : undefined;
}

/** 读取某提供商应注入的环境变量名（用于 /provider 输入 API Key）。 */
export function apiKeyEnvFor(providerId: string, settingsPath = defaultSettingsPath()): string | undefined {
  if (providerId === DEEPSEEK_PROVIDER.id) return DEEPSEEK_PROVIDER.apiKeyEnv;
  const cat = catalogProviderById(providerId);
  if (cat?.catalog) return cat.apiKeyEnv;
  const provider = readCustomProviders(settingsPath).find((p) => p.id === providerId);
  return provider?.apiKeyEnv;
}

// ---------------------------------------------------------------- 持久化

function stateFile(globalStorageDir: string, folderHash: string): string {
  return path.join(globalStorageDir, "model-selection", `${folderHash}.json`);
}

export function loadSelection(globalStorageDir: string, folderHash: string): ModelSelection | undefined {
  try {
    const raw = fs.readFileSync(stateFile(globalStorageDir, folderHash), "utf8");
    const parsed = JSON.parse(raw) as ModelSelection;
    return parsed.provider && parsed.model ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveSelection(
  globalStorageDir: string,
  folderHash: string,
  selection: ModelSelection | undefined
): void {
  const file = stateFile(globalStorageDir, folderHash);
  if (!selection) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 不存在则忽略
    }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(selection, null, 2), "utf8");
}

/** 生成模型选择补丁：把 settings-file.path 指向扩展生成的 settings 覆盖文件。
 * 覆盖文件包含 agent-default-model（用户选择）与原样复制的 llm-pi-ai 提供商块。 */
export function writeModelPatch(
  globalStorageDir: string,
  folderHash: string,
  selection: ModelSelection,
  sourceSettingsPath = defaultSettingsPath()
): string | undefined {
  if (!selection.provider || !selection.model) return undefined;
  const dir = path.join(globalStorageDir, "model-patch");
  fs.mkdirSync(dir, { recursive: true });

  // 1. settings 覆盖文件（settings-file.path 指向它）
  const settingsFile = path.join(dir, `${folderHash}.settings.yaml`);
  const lines = ["# dsh-harness-vscode 生成的设置覆盖（模型选择）", "agent-default-model:", `  provider: ${selection.provider}`, `  model: ${selection.model}`];
  if (selection.reasoningEffort) {
    lines.push(`  reasoningEffort: ${selection.reasoningEffort}`);
  }
  const piBlock = extractBlock(sourceSettingsPath, "llm-pi-ai");
  if (piBlock) {
    lines.push("", piBlock);
  }
  fs.writeFileSync(settingsFile, lines.join("\n") + "\n", "utf8");

  // 2. 补丁：让 settings-file 读扩展的覆盖文件
  const patchFile = path.join(dir, `${folderHash}.patch.yml`);
  fs.writeFileSync(
    patchFile,
    [
      "# dsh-harness-vscode 生成的模型选择补丁（由 /provider /model /effort 管理）",
      "- id: settings",
      "  config:",
      `    path: ${settingsFile.replace(/\\/g, "/")}`,
    ].join("\n") + "\n",
    "utf8"
  );
  return patchFile;
}

/** 原样提取 settings.yaml 中某个顶层键的整块（用于保留 llm-pi-ai 自配提供商）。 */
function extractBlock(settingsPath: string, key: string): string | undefined {
  let lines: string[];
  try {
    lines = fs.readFileSync(settingsPath, "utf8").split(/\r?\n/);
  } catch {
    return undefined;
  }
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `${key}:`) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim()) break;
    block.push(lines[i]);
  }
  return block.join("\n");
}
