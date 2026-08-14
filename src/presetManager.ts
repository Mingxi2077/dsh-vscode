import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * DSH 原生模式预设管理：读写 headless profile 的 cordis.patch.yml。
 * DSH 的 patch 机制：bundle 层（dsh-base/dsh-headless）定义插件行，用户 profile 的
 * cordis.patch.yml 按 id 覆盖配置（last write wins）。扩展的"预设"= 一组按 id
 * 覆盖配置的 patch 行，启用即写入、停用即移除，全部行级文本编辑（cordis.patch.yml
 * 允许 !!js 表达式，不能整文件 YAML 解析）。
 */

export type PresetId =
  | "auto-compact"
  | "strict-plan";

export interface PresetDef {
  id: PresetId;
  name: string;
  description: string;
  /** 英文名/描述（国际化展示用）。 */
  enName?: string;
  enDescription?: string;
  /** 该预设覆盖的插件 id。 */
  targets: string[];
}

export const PRESETS: PresetDef[] = [
  {
    id: "auto-compact",
    name: "自动会话压缩",
    description: "启用 DSH 自动压缩：上下文压力达到阈值（80%）时自动压缩历史，保留 20% 关键信息，长对话不爆上下文",
    enName: "Auto compaction",
    enDescription: "Enable DSH auto-compaction: at 80% context pressure, compress history automatically, keeping 20% key info — long conversations never blow the context.",
    targets: ["compaction-basic"],
  },
  {
    id: "strict-plan",
    name: "严格计划模式（中文）",
    description: "覆盖 plan-mode 指令为中文强化版：先出完整计划再动手，禁止未经批准执行变更",
    enName: "Strict plan mode (Chinese)",
    enDescription: "Override plan-mode instructions with a Chinese, more rigorous version: produce a full plan before acting, no unapproved changes.",
    targets: ["plan-mode"],
  },
];

export function presetById(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** headless profile 的 cordis.patch.yml 路径。 */
export function profilePatchPath(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", "headless", "cordis.patch.yml");
}

/** 读取 patch 原文（不存在返回默认模板）。 */
export function readPatch(file = profilePatchPath()): string {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (raw.trim()) return raw;
  } catch {
    // 不存在则用默认模板
  }
  return "# dsh-vscode 生成的 headless 预设层（由「DSH: 模式预设」管理）\n# 按 id 覆盖 bundle 层配置，last write wins。\n[]\n";
}

/** 当前已启用的预设 id 列表（检测 patch 里是否含对应插件的覆盖行）。 */
export function listEnabledPresets(file = profilePatchPath()): PresetId[] {
  const raw = readPatch(file);
  const enabled: PresetId[] = [];
  for (const preset of PRESETS) {
    // 检查 patch 里是否有该预设的标记注释（我们的写入会带 "dsh-vscode-preset:" 标记）
    if (raw.includes(`dsh-vscode-preset: ${preset.id}`)) {
      enabled.push(preset.id);
    }
  }
  return enabled;
}

/** 某预设是否已启用。 */
export function isPresetEnabled(id: PresetId, file = profilePatchPath()): boolean {
  return listEnabledPresets(file).includes(id);
}

/** 渲染一个预设的 patch 行（覆盖配置 + 标记注释）。 */
function renderPresetEntry(preset: PresetDef): string {
  switch (preset.id) {
    case "auto-compact":
      return [
        `# dsh-vscode-preset: auto-compact`,
        `- id: compaction-basic`,
        `  config:`,
        `    auto: true`,
        `    thresholdRatio: 0.8`,
        `    retainRatio: 0.2`,
      ].join("\n");
    case "strict-plan":
      return [
        `# dsh-vscode-preset: strict-plan`,
        `- id: plan-mode`,
        `  config:`,
        `    section: |`,
        `      你正处于计划模式。在 exit_plan_mode 成功或用户切换会话模式之前，始终停留在计划模式。`,
        `      用户说"实现/修改/执行"等指令意味着先制定计划，而不是立即执行。`,
        `      先探索：使用只读的搜索、静态分析、检查来了解实际代码库，不要编辑文件、改配置、跑格式化、提交代码。`,
        `      计划要决策完整：目标与成功标准、按子系统的改动分组、公共 API/模式/数据流变化、边界情况、测试与验收标准。`,
        `      准备好后，调用 exit_plan_mode 提交完整计划（以 # 标题开头），这是该回复中唯一且最后的工具调用。`,
      ].join("\n");
  }
}

/** 启用预设：写入 cordis.patch.yml（保留现有内容，追加预设条目）。 */
export function enablePreset(
  id: PresetId,
  file = profilePatchPath()
): { ok: boolean; message: string; presetName?: string; enPresetName?: string } {
  const preset = presetById(id);
  if (!preset) return { ok: false, message: `unknown preset: ${id}` };
  if (isPresetEnabled(id, file)) {
    return { ok: true, message: "already-enabled", presetName: preset.name, enPresetName: preset.enName };
  }
  const raw = readPatch(file);
  const entry = renderPresetEntry(preset);
  const next = insertIntoPatch(raw, entry);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, "utf8");
    return { ok: true, message: "enabled", presetName: preset.name, enPresetName: preset.enName };
  } catch (err) {
    return { ok: false, message: `write cordis.patch.yml failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 停用预设：移除对应标记的条目。 */
export function disablePreset(
  id: PresetId,
  file = profilePatchPath()
): { ok: boolean; message: string; presetName?: string; enPresetName?: string } {
  const preset = presetById(id);
  if (!preset) return { ok: false, message: `unknown preset: ${id}` };
  if (!isPresetEnabled(id, file)) {
    return { ok: true, message: "not-enabled", presetName: preset.name, enPresetName: preset.enName };
  }
  const raw = readPatch(file);
  const next = removePresetFromPatch(raw, id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, "utf8");
    return { ok: true, message: "disabled", presetName: preset.name, enPresetName: preset.enName };
  } catch (err) {
    return { ok: false, message: `write cordis.patch.yml failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 把预设条目插入 patch。patch 是顶层 YAML 数组：空时为 `[]`，有内容时为块式条目（- id:）。 */
function insertIntoPatch(raw: string, entry: string): string {
  // 空数组 `[]` → 替换为块式条目（顶层无 [ ] 包裹，DSH patch 的合法形式）
  const emptyMatch = raw.match(/^\s*\[\]\s*$/m);
  if (emptyMatch) {
    return raw.replace(/^\s*\[\]\s*$/m, entry.split("\n").map((l) => (l.trim() ? l : l)).join("\n"));
  }
  // 非空 patch：把新条目追加到最后一个顶层 `- id:` 条目之后
  const lines = raw.split(/\r?\n/);
  // 找到最后一个顶层 `- id:`（缩进 0 或 2？DSH patch 顶层条目是 0 缩进）
  let lastEntryIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*id:/.test(lines[i].trim()) && (lines[i].match(/^ */)?.[0].length ?? 0) === 0) {
      lastEntryIdx = i;
    }
  }
  if (lastEntryIdx >= 0) {
    // 找到该条目结束：下一个顶层 `- id:` 或文件尾
    let end = lastEntryIdx + 1;
    while (end < lines.length) {
      const trimmed = lines[end].trim();
      if (trimmed === "" || (/^-\s*id:/.test(trimmed) && (lines[end].match(/^ */)?.[0].length ?? 0) === 0)) {
        break;
      }
      end++;
    }
    const entryLines = entry.split("\n");
    lines.splice(end, 0, ...entryLines);
    return lines.join("\n");
  }
  // 兜底：拼到末尾
  return raw.trimEnd() + "\n" + entry + "\n";
}

/** 从 patch 移除某预设的标记条目（从标记注释到下一个条目的标记/数组结束）。 */
function removePresetFromPatch(raw: string, id: PresetId): string {
  const marker = `dsh-vscode-preset: ${id}`;
  const lines = raw.split(/\r?\n/);
  // 定位标记行
  const markerIdx = lines.findIndex((l) => l.includes(marker));
  if (markerIdx < 0) return raw;
  // 删除范围：标记行开始。标记行后紧跟的 `- id:`（同预设条目）连同其后续缩进行一起删。
  let end = markerIdx + 1;
  // 跳过紧随标记的 `- id:` 条目行
  if (end < lines.length && /^\s*-\s*id:/.test(lines[end])) {
    end++;
    while (end < lines.length) {
      const trimmed = lines[end].trim();
      // 条目内容：缩进的行；遇到顶层 `- id:` / 标记 / 空行前的缩进行都属于本条目
      if (trimmed === "" || (/^-\s*id:/.test(trimmed) && (lines[end].match(/^ */)?.[0].length ?? 0) === 0) || lines[end].includes("dsh-vscode-preset:")) {
        break;
      }
      end++;
    }
  }
  const kept = [...lines.slice(0, markerIdx), ...lines.slice(end)];
  const joined = kept.join("\n");
  // 数组内已无任何条目（可能残留 [\n] 或注释）时，把数组部分归一化为 []
  const arrMatch = joined.match(/\[\s*\]/s);
  const hasEntries = /\[[^\]]*-\s*id:/.test(joined) || /^-\s*id:/.test(joined.trim());
  if (arrMatch && !hasEntries) {
    return joined.replace(/\[\s*\]/s, "[]");
  }
  return joined;
}
