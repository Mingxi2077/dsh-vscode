import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 用户 ~/.dsh/settings.yaml 中 llm-pi-ai.providers 段的编辑器。
 * DSH 的 llm-pi-ai 插件把该段作为"可配置提供商目录"，写入后下一次请求即生效
 * （无需重启）。本模块只做行级文本编辑：settings.yaml 可能含 !!js 表达式，
 * 不能整文件 YAML 解析后再序列化（会破坏 !!js 标签）。
 */

export interface LlmProviderProfile {
  id: string;
  displayName?: string;
  apiKeyEnv?: string;
  api?: string;
  baseURL?: string;
  models?: { id: string; name?: string }[];
}

export function settingsPath(): string {
  return process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, "settings.yaml")
    : path.join(os.homedir(), ".dsh", "settings.yaml");
}

/** 读取 settings.yaml 原文（不存在返回空串）。 */
export function readSettingsFile(file = settingsPath()): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 判断 llm-pi-ai.providers 段中是否已声明某个 provider id。 */
export function hasProvider(raw: string, providerId: string): boolean {
  // 在 llm-pi-ai: 段内查找 "providers:" 下的 "  <id>:"（缩进 4）
  const lines = raw.split(/\r?\n/);
  let inPi = false;
  let inProviders = false;
  for (const line of lines) {
    const indent = (line.match(/^ */)?.[0].length ?? 0);
    const content = line.trim();
    if (!inPi) {
      if (content === "llm-pi-ai:") inPi = true;
      continue;
    }
    if (indent === 0 && content) break; // 离开 llm-pi-ai 块
    if (content === "providers:" && indent === 2) { inProviders = true; continue; }
    if (indent < 4 && content) inProviders = false;
    if (inProviders && indent === 4 && /^[A-Za-z0-9_-]+:$/.test(content)) {
      if (content.slice(0, -1) === providerId) return true;
    }
  }
  return false;
}

/** 在 llm-pi-ai 块内追加（或替换）一个 provider 配置。返回新文件内容。 */
export function upsertProvider(raw: string, profile: LlmProviderProfile): string {
  const lines = raw.split(/\r?\n/);
  // 找到 llm-pi-ai: 的起始行
  let piIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "llm-pi-ai:") { piIndex = i; break; }
  }

  const block = renderProviderBlock(profile);

  if (piIndex < 0) {
    // 文件里还没有 llm-pi-ai 段：在末尾追加
    const tail = lines.filter((l) => l.trim().length > 0);
    const body = tail.length > 0 ? "\n" : "";
    return body + "llm-pi-ai:\n  providers:\n" + block + "\n";
  }

  // 定位 providers: 行（llm-pi-ai 下缩进 2）
  let providersIndex = -1;
  for (let i = piIndex + 1; i < lines.length; i++) {
    const indent = (lines[i].match(/^ */)?.[0].length ?? 0);
    const content = lines[i].trim();
    if (indent === 0 && content) break;
    if (indent === 2 && content === "providers:") { providersIndex = i; break; }
  }

  if (providersIndex < 0) {
    // 有 llm-pi-ai 但没有 providers：在 llm-pi-ai 块末尾（缩进 0 之前）插入
    let insertAt = piIndex + 1;
    while (insertAt < lines.length && (lines[insertAt].trim() === "" || (lines[insertAt].match(/^ */)?.[0].length ?? 0) > 0)) {
      insertAt++;
    }
    lines.splice(insertAt, 0, "  providers:", ...block.split(/\r?\n/));
    return lines.join("\n");
  }

  // 已存在 providers：看是否已声明该 provider（缩进 4 的 "id:"）
  let providerStart = -1;
  let providerEnd = providersIndex + 1;
  for (let i = providersIndex + 1; i < lines.length; i++) {
    const indent = (lines[i].match(/^ */)?.[0].length ?? 0);
    const content = lines[i].trim();
    if (indent <= 2 && content) break; // 离开 providers 段
    if (indent === 4 && /^[A-Za-z0-9_-]+:$/.test(content)) {
      if (content.slice(0, -1) === profile.id) {
        if (providerStart < 0) providerStart = i;
      } else if (providerStart >= 0) {
        providerEnd = i;
        break;
      }
    }
    if (providerStart >= 0 && i === lines.length - 1) providerEnd = lines.length;
  }

  if (providerStart >= 0) {
    // 替换已有块
    const indent = "    ";
    const newBlock = renderProviderBlock(profile).split(/\r?\n/).map((l) => (l ? indent + l : l));
    lines.splice(providerStart, providerEnd - providerStart, ...newBlock);
    return lines.join("\n");
  }

  // 追加到 providers 段末尾
  let insertAt = providersIndex + 1;
  while (insertAt < lines.length && (lines[insertAt].trim() === "" || (lines[insertAt].match(/^ */)?.[0].length ?? 0) > 2)) {
    insertAt++;
  }
  lines.splice(insertAt, 0, ...block.split(/\r?\n/));
  return lines.join("\n");
}

/** 渲染一个 provider 块（缩进 4，位于 providers: 之下）。 */
function renderProviderBlock(profile: LlmProviderProfile): string {
  const out: string[] = [`    ${profile.id}:`];
  if (profile.displayName) out.push(`      displayName: ${yamlScalar(profile.displayName)}`);
  if (profile.apiKeyEnv) out.push(`      apiKeyEnv: ${profile.apiKeyEnv}`);
  if (profile.api) out.push(`      api: ${profile.api}`);
  if (profile.baseURL) out.push(`      baseURL: ${yamlScalar(profile.baseURL)}`);
  if (profile.models && profile.models.length > 0) {
    out.push("      models:");
    for (const m of profile.models) {
      out.push(`        - id: ${m.id}${m.name ? `\n          name: ${yamlScalar(m.name)}` : ""}`);
    }
  }
  return out.join("\n");
}

/** 简单 YAML 标量：含特殊字符时加引号。 */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value) && !/^[-0-9]/.test(value)) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** 为 catalog provider 生成最小配置块（只写 apiKeyEnv，不写 models——模型由 DSH 目录提供，升级不失效）。 */
export function catalogProfile(id: string, apiKeyEnv: string, displayName?: string): LlmProviderProfile {
  return { id, apiKeyEnv, displayName };
}

/**
 * 把 provider 写入 ~/.dsh/settings.yaml（llm-pi-ai.providers 段）。
 * 写入前备份原文件；失败时回滚。返回是否写入成功（已存在视为成功且不重复写）。
 */
export function writeProviderToSettings(
  profile: LlmProviderProfile,
  file = settingsPath()
): { ok: boolean; message: string; changed: boolean } {
  const raw = readSettingsFile(file);
  if (hasProvider(raw, profile.id)) {
    return { ok: true, message: `提供商 ${profile.id} 已在配置中`, changed: false };
  }
  const next = upsertProvider(raw, profile);
  const backup = `${file}.bak-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (raw.trim()) fs.writeFileSync(backup, raw, "utf8"); // 仅在文件非空时备份
    fs.writeFileSync(file, next, "utf8");
    return { ok: true, message: `已写入 ~/.dsh/settings.yaml（备份 ${path.basename(backup)}）`, changed: true };
  } catch (err) {
    try {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, file);
    } catch {
      // 回滚失败也保留原始错误
    }
    return { ok: false, message: `写入 settings.yaml 失败：${err instanceof Error ? err.message : String(err)}`, changed: false };
  }
}
