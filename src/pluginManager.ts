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
  /** 英文描述（i18n 展示用）。 */
  descriptionEn?: string;
  /** 分类（工具/搜索/可视化/记忆/工作流…）。 */
  category: string;
  /** 英文分类。 */
  categoryEn?: string;
  /** 是否为 bundle 插件（声明 dsh.bundle，安装即激活）。 */
  bundle: boolean;
}

/** 内置精选插件清单（headless + VS Code 场景相关，来自 awesome-dsh-plugin 社区精选）。 */
export const FEATURED_PLUGINS: PluginInfo[] = [
  { packageName: "dsh-toolkit", displayName: "DSH Toolkit", description: "零依赖工具包：time / encoding / json / calculator / csv / regex / markdown / diff / stat / schema 十件套一键安装", descriptionEn: "Zero-dependency tool pack: time / encoding / json / calculator / csv / regex / markdown / diff / stat / schema, one install", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-time", displayName: "Time", description: "严格 ISO 8601 解析、IANA 时区转换、UTC 日历运算", descriptionEn: "Strict ISO 8601 parsing, IANA timezone conversion, UTC calendar math", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-json", displayName: "JSON", description: "JMESPath 子集 JSON 查询", descriptionEn: "JMESPath-subset JSON querying", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-encoding", displayName: "Encoding", description: "base64/url/hex 编解码、常用哈希、UUID 生成", descriptionEn: "base64/url/hex codecs, common hashes, UUID generation", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-calculator", displayName: "Calculator", description: "安全的数学表达式求值器，零依赖递归下降解析器", descriptionEn: "Safe math expression evaluator, zero-dep recursive-descent parser", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-diff", displayName: "Diff", description: "文本/JSON/CSV/Markdown 结构化比较与 unified diff", descriptionEn: "Structured text/JSON/CSV/Markdown comparison & unified diff", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-markdown", displayName: "Markdown", description: "HTML↔Markdown 转换、GFM 表格规范化、目录生成", descriptionEn: "HTML↔Markdown conversion, GFM table normalization, TOC generation", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-regex", displayName: "Regex", description: "正则测试/提取/安全替换/静态解释（不执行代码）", descriptionEn: "Regex test/extract/safe-replace/static explain (no code execution)", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-csv", displayName: "CSV", description: "CSV 解析/查询/统计/转换（RFC 4180）", descriptionEn: "CSV parse/query/stats/convert (RFC 4180)", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-schema", displayName: "Schema", description: "JSON Schema 验证：validate/paths/explain/normalize", descriptionEn: "JSON Schema validation: validate/paths/explain/normalize", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-tool-stat", displayName: "Stat", description: "描述统计/百分位数/频数分布/相关性", descriptionEn: "Descriptive stats / percentiles / frequency / correlation", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-code-intel", displayName: "Code Intel", description: "用 Tree-sitter 建立工作区符号索引，提供词法或可选 embedding 辅助的代码检索", descriptionEn: "Tree-sitter workspace symbol index with lexical or optional embedding-assisted code search", category: "代码", categoryEn: "Code", bundle: true },
  { packageName: "dsh-plugin-git-workflow", displayName: "Git Workflow", description: "一等公民的 Git 工具：status / diff / log / commit / branch，零 shell 调用杜绝注入", descriptionEn: "First-class Git tools: status / diff / log / commit / branch, zero shell calls, injection-proof", category: "代码", categoryEn: "Code", bundle: true },
  { packageName: "dsh-custom-tool", displayName: "Custom Tool", description: "用 Monaco 编辑器创建和管理沙箱化的自定义 JavaScript 工具", descriptionEn: "Create and manage sandboxed custom JavaScript tools with the Monaco editor", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-subagent-tools", displayName: "Subagent Tools", description: "子代理委派的按调用覆盖：model/provider/persona/toolFilter、@preset 引用", descriptionEn: "Per-call overrides for subagent delegation: model/provider/persona/toolFilter, @preset refs", category: "工作流", categoryEn: "Workflow", bundle: true },
  { packageName: "dsh-bash-terminal", displayName: "Bash Terminal", description: "一个 shell 工具：Windows 上统一执行 PowerShell / Git Bash / WSL，外加交互式 PTY 终端", descriptionEn: "One shell tool: runs PowerShell / Git Bash / WSL uniformly on Windows, plus an interactive PTY terminal", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-docker", displayName: "Docker", description: "类型安全、带护栏的容器控制：ps/logs/inspect/exec/start/stop 与 compose，破坏性操作需审批", descriptionEn: "Type-safe guarded container control: ps/logs/inspect/exec/start/stop & compose; destructive ops need approval", category: "集成", categoryEn: "Integration", bundle: true },
  { packageName: "dsh-backup", displayName: "DSH Backup", description: "一键备份 DSH 用户数据：/backup 命令、定时自动备份、sha256 校验与自动轮换", descriptionEn: "One-click DSH data backup: /backup command, scheduled auto-backup, sha256 checks, auto rotation", category: "运维", categoryEn: "Ops", bundle: true },
  { packageName: "dsh-skillport", displayName: "Skillport", description: "把已有的 Agent Skills（SKILL.md）技能库带进 DSH：扫描 Claude/Codex/Cursor 技能目录、按需加载", descriptionEn: "Bring existing Agent Skills (SKILL.md) into DSH: scan Claude/Codex/Cursor skill dirs, load on demand", category: "技能", categoryEn: "Skills", bundle: true },
  { packageName: "dsh-md-preview", displayName: "MD Preview", description: "把 Markdown 渲染为自包含独立 HTML 页面，headless 下也有 md_html_render 工具", descriptionEn: "Render Markdown as self-contained HTML; md_html_render tool works in headless too", category: "工具", categoryEn: "Tools", bundle: true },
  { packageName: "dsh-undo-plugin", displayName: "Undo/Rollback", description: "配置变更自动存档，一键撤销/恢复/回退到任意版本", descriptionEn: "Auto-archive config changes; one-click undo/restore/rollback to any version", category: "运维", categoryEn: "Ops", bundle: true },
  { packageName: "dsh-session-audit", displayName: "Session Audit", description: "会话执行分析：步骤、工具调用、失败、重复动作、token 用量与验证信号，输出报告", descriptionEn: "Session execution analysis: steps, tool calls, failures, repeats, token usage & verification signals", category: "分析", categoryEn: "Analysis", bundle: true },
  { packageName: "dsh-excel-chat", displayName: "Excel Chat", description: "对话完成 Excel 工作：建表、编辑、修复公式、图表校验，每次编辑后自动体检公式", descriptionEn: "Do Excel work by chat: create/edit sheets, fix formulas, chart validation, auto formula check after each edit", category: "办公", categoryEn: "Office", bundle: true },
  { packageName: "dsh-voice", displayName: "Voice", description: "语音输入、语音输出：口述转写为用户消息，agent 朗读回复，本地优先", descriptionEn: "Voice in/out: transcribe speech to messages, agent speaks replies, local-first", category: "办公", categoryEn: "Office", bundle: true },
  { packageName: "dsh-remote", displayName: "Remote", description: "管理多台 SSH 主机，远程工作区镜像成本地文件夹并用 rw_* 工具操作", descriptionEn: "Manage SSH hosts; mirror remote workspaces as local folders with rw_* tools", category: "集成", categoryEn: "Integration", bundle: true },
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

/** 官方核心 bundles，不参与兼容性检测。 */
export const OFFICIAL_BUNDLES = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]);

/** 找出未检测过的新插件（排除官方 bundles）。纯函数，便于测试。
 * 用于"哨兵"：无论插件由谁安装（插件中心 UI / 聊天中 agent / 外部），都能被发现。 */
export function findNewPlugins(installed: InstalledPlugin[], checked: string[]): InstalledPlugin[] {
  const checkedSet = new Set(checked);
  return installed.filter((p) => !OFFICIAL_BUNDLES.has(p.packageName) && !checkedSet.has(p.packageName));
}

export interface PluginCommandResult {
  ok: boolean;
  message: string;
  /** 安装/卸载后是否为 bundle 激活状态。 */
  active?: boolean;
  /** 失败原因分类（供 UI 翻译成友好双语消息）。 */
  kind?: "dep404" | "network" | "generic";
  /** dep404 时缺失的依赖包名。 */
  missingDep?: string;
  /** 提取的关键错误行（已过滤误导行）。 */
  detail?: string;
}

export interface PluginErrorAnalysis {
  kind: "dep404" | "network" | "generic";
  /** dep404 时缺失的依赖包名。 */
  missingDep?: string;
  /** 供展示的关键错误行（已过滤误导行、去重、限长）。 */
  lines: string[];
}

/** 从 pnpm/dsh 错误输出中提取缺失依赖的包名（支持官方 registry 与 npmmirror CDN 两种 URL 形式）。 */
export function extractMissingDep(output: string): string | undefined {
  // npmmirror CDN: https://cdn.npmmirror.com/packages/%40deepseek-ai/dsh-type-meta/0.0.1-rc.1/...
  const m1 = output.match(/packages\/((?:%40[^\/]+\/)?[^\/]+)\//);
  if (m1) return decodeURIComponent(m1[1].replace(/%2f/gi, "/"));
  // 官方 registry: https://registry.npmjs.org/@deepseek-ai%2fdsh-type-meta 或 /@scope/pkg 或 /pkg
  const m2 = output.match(/registry\.npmjs\.org\/((?:@[^\/\s]+(?:%2f|\/)[^\/\s@]+)|[^\/\s@]+)/i);
  if (m2) return decodeURIComponent(m2[1].replace(/%2f/gi, "/"));
  // 兜底: GET https://.../<pkg> 或 <scope>/<pkg>
  const m3 = output.match(/GET\s+https?:\/\/[^\s]+\/((?:@[^\/\s]+(?:\/|%2f)[^\/\s@]+)|[^\/\s@]+)(?:@|\/|$)/i);
  if (m3) return decodeURIComponent(m3[1].replace(/%2f/gi, "/"));
  return undefined;
}

/** 从 pnpm/dsh 错误输出中分类失败原因并提取关键错误行。
 * dep404: 依赖在 npm 上不存在（404）→ 插件自身依赖未发布，无法安装。
 * network: 网络不可达/超时/代理问题 → 可重试或检查网络。
 * generic: 其它真实错误。
 * 同时过滤 DSH 附加的通用误导提示行，避免把"提示"当成"原因"。 */
export function analyzePluginError(stdout: string, stderr: string): PluginErrorAnalysis {
  const combined = stdout + "\n" + stderr;
  const lines = combined.split(/\r?\n/);
  // 过滤 DSH 的通用误导提示行
  const meaningful = lines.filter(
    (l) => !l.includes("git-hosted plugins build on install") && !l.includes("add the exact key pnpm printed")
  );
  const cap = (ls: string[], n: number) =>
    ls
      .filter((l) => l.trim())
      .map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l))
      .slice(0, n);

  // --- dep404 ---
  if (/404\s+Not Found|ERR_PNPM_FETCH_404|Not Found - GET/.test(combined)) {
    const keyLines = meaningful.filter((l) => /404|Not Found|npm error|ERR_PNPM_FETCH_404|GET https?:/.test(l));
    return {
      kind: "dep404",
      missingDep: extractMissingDep(combined),
      lines: cap(keyLines.length ? keyLines : meaningful, 6),
    };
  }
  // --- network ---
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network unreachable|couldn'?t connect|tunneling socket|ERR_PNPM_FETCH_5\d\d/i.test(combined)) {
    const keyLines = meaningful.filter((l) =>
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|proxy|connect|FETCH_5\d\d/i.test(l)
    );
    return { kind: "network", lines: cap(keyLines.length ? keyLines : meaningful, 6) };
  }
  // --- generic: 优先 error 行，否则跳过 Progress 进度行的真实输出 ---
  const errLines = meaningful.filter((l) => /npm error|ERR_PNPM|pnpm error|error\s*:|failed/i.test(l));
  const fallback = meaningful.filter((l) => !/^Progress:/i.test(l.trim()));
  return { kind: "generic", lines: cap(errLines.length ? errLines : fallback, 8) };
}

/** 把 github 短名（github:owner/repo 或 owner/repo，可带 #ref）转成显式 git+https URL。
 * pnpm 对 `github:` 协议可能解析成 git+ssh://（无 ssh key 时 clone 失败 exit 128）；
 * 显式 https 一定走 https + 代理，Windows 无 ssh key 环境也可靠。 */
export function githubShortToHttps(input: string): string {
  const s = input.trim();
  const [base, ref] = s.replace(/^github:/, "").split("#");
  const m = base.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return s;
  return `git+https://github.com/${m[1]}/${m[2]}.git${ref ? `#${ref}` : ""}`;
}

/** 识别插件安装来源类型（npm 包名 / github: 短名 / owner/repo 短名 / git URL / tarball URL / 本地路径）。 */
export function installSourceKind(input: string): "npm" | "github" | "git-url" | "url" | "path" {
  const s = input.trim();
  if (!s) return "npm";
  if (s.startsWith("github:")) return "github";
  if (s.startsWith("git+") || s.startsWith("git:") || /^[\w.-]+@[\w.-]+:/.test(s)) return "git-url";
  if (/^https?:\/\//.test(s)) return s.endsWith(".git") ? "git-url" : "url";
  if (/^[./\\]|^[A-Za-z]:[\\/]/.test(s)) return "path";
  // owner/repo 短名（npm 包名不允许裸斜杠；scoped 包以 @ 开头，这里排除）
  if (/^[^@][\w.-]+\/[\w.-]+$/.test(s)) return "github";
  return "npm";
}

/** 从 pnpm 错误输出中提取需要允许 build 脚本的包名（onlyBuiltDependencies）。
 * pnpm 可能把错误打到 stdout 或 stderr，两者都查。导出便于测试。 */
export function extractBuiltAllowNames(output: string): string[] {
  const names: string[] = [];
  // 格式1: The git-hosted package "@scope/pkg@1.0.0" needs to execute build scripts...
  const m1 = output.match(/"((?:@[\w.-]+\/)?[\w.-]+)@[\d.]+" needs to execute build scripts/);
  if (m1) names.push(m1[1]);
  // 格式2: onlyBuiltDependencies: 示例下的 "- "@scope/pkg""
  const m2 = output.match(/onlyBuiltDependencies:\s*[\s\S]{0,60}?-\s*["']((?:@[\w.-]+\/)?[\w.-]+)["']/);
  if (m2) names.push(m2[1]);
  // 格式3: "Add the package to onlyBuiltDependencies" 后面最近的包名
  const m3 = output.match(/Add the package to "onlyBuiltDependencies"[^\n]*?[\n]?onlyBuiltDependencies:\s*\n\s*-\s*["']((?:@[\w.-]+\/)?[\w.-]+)["']/);
  if (m3) names.push(m3[1]);
  // 格式4: DSH 的 "add the exact key pnpm printed above" 措辞后无包名，退回格式1/2
  return [...new Set(names)];
}

/** headless profile 的 pnpm-workspace.yaml 路径。 */
export function pnpmWorkspacePath(): string {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", "headless", "pnpm-workspace.yaml");
}

/** 把包名加入 pnpm-workspace.yaml 的 onlyBuiltDependencies（git 插件 build 许可）。 */
export function allowBuildScripts(pkgName: string, file = pnpmWorkspacePath()): boolean {
  try {
    let raw = fs.readFileSync(file, "utf8");
    // 已作为独立列表项存在则跳过（无论是否 scoped）
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`^\\s*-\\s*['"]?${escaped}['"]?\\s*$`, "m").test(raw)) {
      return true;
    }
    // 规范化：把 "onlyBuiltDependencies:  - 'x'"（键+内联列表）拆成两行
    raw = raw.replace(/(onlyBuiltDependencies:)\s+(-[^\n]*)/g, "$1\n  $2");
    // 追加包名
    if (!/^\s*onlyBuiltDependencies:/m.test(raw)) {
      raw = raw.trimEnd() + "\n\nonlyBuiltDependencies:\n";
    }
    raw = raw.trimEnd() + "\n  - '" + pkgName + "'\n";
    fs.writeFileSync(file, raw, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 执行 dsh plugin 子命令（add/rm）。通过 entry 模式启动 bin.js。
 * 安装 git/URL 来源时若被 pnpm 的 onlyBuiltDependencies 拦截，自动加入允许列表并重试（最多 2 次）。 */
export function runPluginCommand(
  cli: ResolvedCli,
  action: "add" | "rm",
  packageName: string,
  retryCount = 0
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
      resolve({ ok: false, message: `plugin command timed out (${packageName})` });
    }, 180000);
    // 等输出流 end + 进程 close 全部就绪再处理：0.9.5 只等 end 导致 close（写入
    // codeRef）晚于 finish() 触发，codeRef 恒为 null → 成功安装被误判为失败
    let outDone = false;
    let errDone = false;
    let closeDone = false;
    let settled = false;
    const finish = () => {
      if (!outDone || !errDone || !closeDone || settled) return;
      settled = true;
      clearTimeout(timer);
      if (codeRef === 0) {
        const active = action === "add" ? isActive(packageName) : undefined;
        const detail = stdout.trim().split(/\r?\n/).filter((l) => l.includes("bundle") || l.includes("warning")).join(" ");
        const suffix = detail ? ` (${detail.slice(0, 120)})` : "";
        resolve({
          ok: true,
          active,
          message: action === "add" ? `installed ${packageName}${suffix}` : `removed ${packageName}`,
        });
      } else if (action === "add" && retryCount < 2 && /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|needs to execute build scripts but is not in the "onlyBuiltDependencies"/.test(stdout)) {
        // git/URL 插件需要 build 许可（pnpm 真实错误在 stdout）：解析包名 → 加入允许列表 → 重试
        const names = extractBuiltAllowNames(stdout + "\n" + stderr);
        if (names.length > 0) {
          const allowed = names.every((n) => allowBuildScripts(n));
          if (allowed) {
            void runPluginCommand(cli, action, packageName, retryCount + 1).then(resolve);
            return;
          }
        }
        resolve({
          ok: false,
          message:
            `install ${packageName} needs build-script permission (onlyBuiltDependencies) but auto-handling failed: ` +
            `could not extract the package name from the error. Try installing again, or check the DSH output panel.`,
        });
      } else {
        // 非 build 许可错误：分类并提取关键错误行（避免 300 字符截断丢失真实原因）
        const analysis = analyzePluginError(stdout, stderr);
        const actionWord = action === "add" ? "install" : "remove";
        const detail = analysis.lines.join("\n");
        if (analysis.kind === "dep404") {
          resolve({
            ok: false,
            kind: "dep404",
            missingDep: analysis.missingDep,
            detail,
            message:
              `install ${packageName} failed: ` +
              (analysis.missingDep
                ? `dependency "${analysis.missingDep}" is not published on npm (404), so this plugin cannot be installed. Report it to the plugin author or try another plugin.`
                : `a dependency was not found on npm (404), so this plugin cannot be installed. Report it to the plugin author or try another plugin.`),
          });
        } else if (analysis.kind === "network") {
          resolve({
            ok: false,
            kind: "network",
            detail,
            message: `${actionWord} ${packageName} failed: network error while contacting the registry. Check your connection / proxy and retry.`,
          });
        } else {
          resolve({
            ok: false,
            message: `${actionWord} ${packageName} failed (exit ${codeRef}): ${detail}`,
          });
        }
      }
    };
    let codeRef: number | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stdout.on("end", () => {
      outDone = true;
      finish();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stderr.on("end", () => {
      errDone = true;
      finish();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, message: `spawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      codeRef = code;
      closeDone = true;
      finish();
    });
  });
}
