import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { ResolvedCli } from "./cli";

/**
 * DSH 插件管理：操作 headless profile 的插件（bundle 激活 / 非 bundle 依赖）。
 * 机制：`dsh plugin --profile headless add|rm <pkg>` = 在 profile 目录跑 pnpm add/remove，
 * 安装后 DSH 会自动 reconcile——包声明 `dsh.bundle` 就加入 profile 的 bundles 层（激活），
 * 否则仅作为依赖安装（不激活）。
 */

export interface PluginInfo {
  /** npm 包名（dsh plugin add 用的名字）。 */
  packageName: string;
  /** 展示名。 */
  displayName: string;
  /** 中文描述。 */
  description: string;
  /** 分类（工具/搜索/可视化/记忆/工作流…）。 */
  category: string;
  /** 是否为 bundle 插件（声明 dsh.bundle，安装即激活）。 */
  bundle: boolean;
}

/** 内置精选插件清单（headless + VS Code 场景相关，来自 awesome-dsh-plugin 社区精选）。 */
export const FEATURED_PLUGINS: PluginInfo[] = [
  { packageName: "dsh-toolkit", displayName: "DSH Toolkit", description: "零依赖工具包：time / encoding / json / calculator / csv / regex / markdown / diff / stat / schema 十件套一键安装", category: "工具", bundle: true },
  { packageName: "dsh-tool-time", displayName: "Time 工具", description: "严格 ISO 8601 解析、IANA 时区转换、UTC 日历运算", category: "工具", bundle: true },
  { packageName: "dsh-tool-json", displayName: "JSON 工具", description: "JMESPath 子集 JSON 查询", category: "工具", bundle: true },
  { packageName: "dsh-tool-encoding", displayName: "Encoding 工具", description: "base64/url/hex 编解码、常用哈希、UUID 生成", category: "工具", bundle: true },
  { packageName: "dsh-tool-calculator", displayName: "Calculator 工具", description: "安全的数学表达式求值器，零依赖递归下降解析器", category: "工具", bundle: true },
  { packageName: "dsh-tool-diff", displayName: "Diff 工具", description: "文本/JSON/CSV/Markdown 结构化比较与 unified diff", category: "工具", bundle: true },
  { packageName: "dsh-tool-markdown", displayName: "Markdown 工具", description: "HTML↔Markdown 转换、GFM 表格规范化、目录生成", category: "工具", bundle: true },
  { packageName: "dsh-tool-regex", displayName: "Regex 工具", description: "正则测试/提取/安全替换/静态解释（不执行代码）", category: "工具", bundle: true },
  { packageName: "dsh-tool-csv", displayName: "CSV 工具", description: "CSV 解析/查询/统计/转换（RFC 4180）", category: "工具", bundle: true },
  { packageName: "dsh-tool-schema", displayName: "Schema 工具", description: "JSON Schema 验证：validate/paths/explain/normalize", category: "工具", bundle: true },
  { packageName: "dsh-tool-stat", displayName: "Stat 工具", description: "描述统计/百分位数/频数分布/相关性", category: "工具", bundle: true },
  { packageName: "dsh-code-intel", displayName: "Code Intel", description: "用 Tree-sitter 建立工作区符号索引，提供词法或可选 embedding 辅助的代码检索", category: "代码", bundle: true },
  { packageName: "dsh-plugin-git-workflow", displayName: "Git Workflow", description: "一等公民的 Git 工具：status / diff / log / commit / branch，零 shell 调用杜绝注入", category: "代码", bundle: true },
  { packageName: "dsh-custom-tool", displayName: "Custom Tool", description: "用 Monaco 编辑器创建和管理沙箱化的自定义 JavaScript 工具", category: "工具", bundle: true },
  { packageName: "dsh-subagent-tools", displayName: "Subagent Tools", description: "子代理委派的按调用覆盖：model/provider/persona/toolFilter、@preset 引用", category: "工作流", bundle: true },
  { packageName: "dsh-bash-terminal", displayName: "Bash Terminal", description: "一个 shell 工具：Windows 上统一执行 PowerShell / Git Bash / WSL，外加交互式 PTY 终端", category: "工具", bundle: true },
  { packageName: "dsh-docker", displayName: "Docker 控制", description: "类型安全、带护栏的容器控制：ps/logs/inspect/exec/start/stop 与 compose，破坏性操作需审批", category: "集成", bundle: true },
  { packageName: "dsh-backup", displayName: "DSH Backup", description: "一键备份 DSH 用户数据：/backup 命令、定时自动备份、sha256 校验与自动轮换", category: "运维", bundle: true },
  { packageName: "dsh-skillport", displayName: "Skillport", description: "把已有的 Agent Skills（SKILL.md）技能库带进 DSH：扫描 Claude/Codex/Cursor 技能目录、按需加载", category: "技能", bundle: true },
  { packageName: "dsh-md-preview", displayName: "MD Preview", description: "把 Markdown 渲染为自包含独立 HTML 页面，headless 下也有 md_html_render 工具", category: "工具", bundle: true },
  { packageName: "dsh-undo-plugin", displayName: "Undo/回退", description: "配置变更自动存档，一键撤销/恢复/回退到任意版本", category: "运维", bundle: true },
  { packageName: "dsh-session-audit", displayName: "Session Audit", description: "会话执行分析：步骤、工具调用、失败、重复动作、token 用量与验证信号，输出报告", category: "分析", bundle: true },
  { packageName: "dsh-excel-chat", displayName: "Excel Chat", description: "对话完成 Excel 工作：建表、编辑、修复公式、图表校验，每次编辑后自动体检公式", category: "办公", bundle: true },
  { packageName: "dsh-voice", displayName: "Voice 语音", description: "语音输入、语音输出：口述转写为用户消息，agent 朗读回复，本地优先", category: "办公", bundle: true },
  { packageName: "dsh-remote", displayName: "Remote 多机", description: "管理多台 SSH 主机，远程工作区镜像成本地文件夹并用 rw_* 工具操作", category: "集成", bundle: true },
  { packageName: "dsh-net-proxy", displayName: "Net Proxy", description: "让 agent 的网络请求走本机 HTTP/CONNECT/SOCKS5 代理", category: "网络", bundle: true },
];

/** 按包名查找精选插件。 */
export function featuredPlugin(packageName: string): PluginInfo | undefined {
  return FEATURED_PLUGINS.find((p) => p.packageName === packageName);
}

/** headless profile 的 package.json 路径。 */
export function profilePackageJsonPath(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", "headless", "package.json");
}

export interface InstalledPlugin {
  packageName: string;
  /** true = 在 dsh.profile.bundles 层（激活）；false = 仅依赖（未激活）。 */
  active: boolean;
  version?: string;
}

/** 读取 headless profile 当前已装插件（dependencies + bundles）。 */
export function readInstalledPlugins(profilePkg = profilePackageJsonPath()): InstalledPlugin[] {
  let pkg: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };
  try {
    pkg = JSON.parse(fs.readFileSync(profilePkg, "utf8"));
  } catch {
    return [];
  }
  const bundles = new Set(pkg.dsh?.profile?.bundles ?? []);
  const deps = pkg.dependencies ?? {};
  const out: InstalledPlugin[] = [];
  for (const [name, version] of Object.entries(deps)) {
    out.push({ packageName: name, active: bundles.has(name), version: String(version) });
  }
  // 只进 bundles 但不在 dependencies 的（理论上 reconcile 会同步，防御性补上）
  for (const b of bundles) {
    if (!deps[b]) out.push({ packageName: b, active: true });
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/** 是否已安装（依赖层存在即算）。 */
export function isInstalled(packageName: string): boolean {
  return readInstalledPlugins().some((p) => p.packageName === packageName);
}

/** 是否已激活（在 bundles 层）。 */
export function isActive(packageName: string): boolean {
  return readInstalledPlugins().some((p) => p.packageName === packageName && p.active);
}

export interface PluginCommandResult {
  ok: boolean;
  message: string;
  /** 安装/卸载后是否为 bundle 激活状态。 */
  active?: boolean;
}

/** 执行 dsh plugin 子命令（add/rm）。通过 entry 模式启动 bin.js。 */
export function runPluginCommand(
  cli: ResolvedCli,
  action: "add" | "rm",
  packageName: string
): Promise<PluginCommandResult> {
  return new Promise((resolve) => {
    const args =
      cli.kind === "entry"
        ? ["--expose-internals", cli.entry, "plugin", "--profile", "headless", action, packageName]
        : ["plugin", "--profile", "headless", action, packageName];
    const child = spawn(cli.kind === "entry" ? cli.node : cli.command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, message: `插件命令超时（${packageName}）` });
    }, 120000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `spawn 失败：${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const active = action === "add" ? isActive(packageName) : undefined;
        const detail = stdout.trim().split(/\r?\n/).filter((l) => l.includes("bundle") || l.includes("warning")).join(" ");
        const suffix = detail ? `（${detail.slice(0, 120)}）` : "";
        resolve({
          ok: true,
          active,
          message: action === "add" ? `已安装 ${packageName}${suffix}` : `已卸载 ${packageName}`,
        });
      } else {
        resolve({ ok: false, message: `${action === "add" ? "安装" : "卸载"} ${packageName} 失败(exit ${code}): ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}` });
      }
    });
  });
}
