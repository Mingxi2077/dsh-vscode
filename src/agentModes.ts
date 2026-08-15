import * as fs from "fs";
import * as path from "path";
import type { ResolvedCli } from "./cli";

/**
 * DSH 内置 Agent 预设（标准 / PTC / 极简 / 创造）接入。
 *
 * 预设选择在 DSH Web 端由 `agentPreset.select` API 完成；headless runner 本身
 * 不会挂载预设。但实测 DSH 的每个预设目录都自带 `agent.cordis.yml`，且该文件
 * 可以作为 `--patch` overlay 直接叠加到 headless 组合上（headless 每任务一个
 * 进程，不存在 Web 端多会话共享 isolate realm 的冲突问题）。
 *
 * 因此这里只负责：
 * 1) 定义四种模式的展示信息；
 * 2) 从当前 dsh 安装目录解析对应 `config/agent-presets/<id>/agent.cordis.yml`。
 *    用安装目录里的文件而不是扩展自带副本，保证跟随 dsh 升级。
 */

export type AgentModeId = "standard" | "code" | "minimal" | "cordis";

export interface AgentModeInfo {
  id: AgentModeId;
  name: string;
  nameEn: string;
  description: string;
  descriptionEn: string;
  /** 该模式的风险/注意说明（创造模式会写运行时，必须醒目）。 */
  warning?: string;
  warningEn?: string;
}

export const AGENT_MODES: AgentModeInfo[] = [
  {
    id: "standard",
    name: "标准模式",
    nameEn: "Standard",
    description: "功能完整的编码 Agent：文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。",
    descriptionEn: "Full-featured coding agent: file editing, shell, file & web search, Skills, planning, goals, subagents and workflows.",
  },
  {
    id: "code",
    name: "PTC 模式",
    nameEn: "PTC",
    description: "具备标准模式全部能力，并通过 Code Mode SDK 呈现工具：模型用 TypeScript 程序把多步操作合并成一次工具调用。",
    descriptionEn: "Everything in Standard, with tools presented through the Code Mode SDK: the model composes multi-step actions in one TypeScript program.",
  },
  {
    id: "minimal",
    name: "极简模式",
    nameEn: "Minimal",
    description: "仅提供持久 bash 与 str_replace_editor 两个工具的极简编码 Agent（固定系统提示，无自动压缩）。",
    descriptionEn: "Minimal two-tool coding agent: persistent bash and str_replace_editor only (fixed system prompt, no auto-compaction).",
  },
  {
    id: "cordis",
    name: "创造模式",
    nameEn: "Creator",
    description: "用于创作自定义 Agent 预设：具备标准模式全部能力，并提供运行时检查、插件实验和 preset 创作指导。",
    descriptionEn: "For authoring custom agent presets: full Standard capabilities plus runtime inspection, plugin experiments and preset-authoring guidance.",
    warning: "创造模式会读写你正在运行的 DSH 运行时，相当于把 shell 权限交给模型。只对可信任务使用。",
    warningEn: "Creator mode can read and modify the running DSH runtime — treat it as shell access. Use only for trusted tasks.",
  },
];

export function agentModeById(id: string | undefined): AgentModeInfo | undefined {
  return AGENT_MODES.find((m) => m.id === id);
}

export function isValidAgentMode(id: unknown): id is AgentModeId {
  return typeof id === "string" && AGENT_MODES.some((m) => m.id === id);
}

/** 从 dsh 入口解析内置预设根目录（lib/bin.js → ../config/agent-presets）。 */
function shippedPresetRoot(cli: ResolvedCli): string | undefined {
  try {
    if (cli.kind === "entry") {
      return path.resolve(path.dirname(cli.entry), "..", "config", "agent-presets");
    }
    // command 模式多为 POSIX symlink：realpath 后按同样布局推导
    const real = fs.realpathSync.native(cli.command);
    return path.resolve(path.dirname(real), "..", "config", "agent-presets");
  } catch {
    return undefined;
  }
}

export interface AgentModePatch {
  /** 可直接追加到 --patch 的预设组成文件；undefined = 解析失败。 */
  patch: string | undefined;
  /** 解析失败原因（供 UI 提示）。 */
  error?: string;
  /** 解析到的预设 id（与传入一致时表示成功找到）。 */
  id: AgentModeId;
}

/** 解析某模式的 --patch 文件路径（优先当前 dsh 安装目录）。 */
export function resolveAgentModePatch(cli: ResolvedCli, id: AgentModeId): AgentModePatch {
  const info = agentModeById(id)!;
  const root = shippedPresetRoot(cli);
  const candidates = root
    ? [path.join(root, id, "agent.cordis.yml")]
    : [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { patch: candidate, id };
  }
  return {
    patch: undefined,
    error: root
      ? `未在 dsh 安装目录找到 ${info.name} 预设文件（${candidates.join(", ")}）`
      : `无法从当前 dsh 启动方式推导预设目录（${info.name}）`,
    id,
  };
}
