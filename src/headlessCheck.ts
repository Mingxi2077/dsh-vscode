import { spawn } from "child_process";
import { ResolvedCli } from "./cli";

/**
 * headless 兼容性检测：通过 `dsh --profile headless --dump-config` 的运行时输出，
 * 客观判断一个插件在 headless profile 组合中的实际加载情况。
 *
 * 原理：DSH 的组合引擎把 bundles 层 / profile 层 / 用户 patch 按顺序叠加，
 * dump-config 打印的就是运行时真实组合结果——每个第三方插件都会留下痕迹：
 *   - patch 来源标注：`# == <包名>`（该包作为 bundle 参与组合）
 *   - 插件行：`- id: <id>` / `name: <包名>`
 *   - patch 生效：`# == <某层>, patched by <包名>`
 *   - 警告：`patch: entry "<id>" not found`（引用了不存在的插件 id）
 *
 * 边界（务必向用户说明，避免纠纷）：
 *   - 本检测只保证「能否被 DSH 加载、patch 是否生效」——这是运行时客观事实，100% 准确。
 *   - 不保证「功能是否真正可用」：依赖外部 API（如 FIRECRAWL_API_KEY）、Web 端 UI 组件、
 *     特定宿主服务的插件，即使加载成功也可能不生效，这无法静态/加载期预测。
 */

export type HeadlessCheckLevel = "ok" | "warning" | "inactive" | "fail";

/** 检测级别的展示图标（供插件中心与自动提醒共用）。 */
export function compatLevelIcon(level: HeadlessCheckLevel): string {
  switch (level) {
    case "ok":
      return "✅";
    case "warning":
      return "⚠️";
    case "inactive":
      return "⚪";
    default:
      return "❌";
  }
}

export interface HeadlessCheckResult {
  level: HeadlessCheckLevel;
  /** 检测的包名。 */
  packageName: string;
  /** dump-config 是否成功运行。 */
  ran: boolean;
  /** 插件是否以 bundle 参与组合（有 `# == <pkg>` 来源块）。 */
  hasPatchBlock: boolean;
  /** 该插件声明的插件行 id 中，在组合树里能找到的。 */
  matchedEntries: string[];
  /** `patch: entry "<id>" not found` 警告（该插件行无实现，不生效）。 */
  missingEntries: string[];
  /** 人类可读摘要（英文，由 UI 层翻译）。 */
  summary: string;
}

const DUMP_TIMEOUT_MS = 60000;

/** 运行 `dsh --profile headless --dump-config`，返回 { stdout, stderr, exitCode }。导出便于测试。 */
export function runDumpConfig(cli: ResolvedCli): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args =
      cli.kind === "entry"
        ? ["--expose-internals", cli.entry, "--profile", "headless", "--dump-config"]
        : ["--profile", "headless", "--dump-config"];
    const child = spawn(cli.kind === "entry" ? cli.node : cli.command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DUMP_TIMEOUT_MS);
    let outDone = false;
    let errDone = false;
    let closeDone = false;
    let exitCode: number | null = null;
    const finish = () => {
      if (!outDone || !errDone || !closeDone || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stdout.on("end", () => {
      outDone = true;
      finish();
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stderr.on("end", () => {
      errDone = true;
      finish();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: -1, timedOut: false });
    });
    child.on("close", (code) => {
      exitCode = code;
      closeDone = true;
      finish();
    });
  });
}

/** 从 dump-config 输出中解析某个包名的加载情况。导出便于测试。 */
export function parseDumpConfig(
  dumpText: string,
  packageName: string
): Pick<HeadlessCheckResult, "level" | "hasPatchBlock" | "matchedEntries" | "missingEntries"> {
  const lines = dumpText.split(/\r?\n/);
  // patch 来源标注：`# == <包名>` 表示该包作为 bundle 参与了组合
  const hasPatchBlock = lines.some((l) => l.trim() === `# == ${packageName}`);
  // 插件行：`name: <包名>` 匹配（值可能带单/双引号，如 name: '@scope/pkg' 或 name: pkg）
  const matchedEntries = lines
    .filter((l) => {
      const nameMatch = l.match(/^\s*name:\s*(.+)$/);
      if (nameMatch === null) return false;
      const clean = nameMatch[1].trim().replace(/^['"](.*)['"]$/, "$1");
      return clean === packageName;
    })
    .map((l) => l.trim());
  // entry not found 警告：`dsh: [<包名>] patch: entry "<id>" not found` —— 方括号里是 patch 来源包名
  const missingEntries = lines
    .filter((l) => /patch: entry ".*" not found/.test(l) && l.includes(packageName))
    .map((l) => l.trim());
  // 有该包的 entry 警告 → 它声明为 bundle 但补丁行缺失（部分不生效），比 inactive 更值得警示
  const level = missingEntries.length > 0 ? "warning" : hasPatchBlock ? "ok" : "inactive";
  return { level, hasPatchBlock, matchedEntries, missingEntries };
}

/** 对已安装插件执行 headless 兼容性检测。 */
export async function checkPluginHeadless(cli: ResolvedCli, packageName: string): Promise<HeadlessCheckResult> {
  const { stdout, stderr, exitCode, timedOut } = await runDumpConfig(cli);
  const dump = stdout + "\n" + stderr;
  if (timedOut || exitCode !== 0 || (stdout.trim() === "" && stderr.trim() === "")) {
    return {
      level: "fail",
      packageName,
      ran: false,
      hasPatchBlock: false,
      matchedEntries: [],
      missingEntries: [],
      summary: `compatibility check could not run (${timedOut ? "timed out" : exitCode === -1 ? "spawn failed" : `exit ${exitCode}`}). Try again from the plugin center.`,
    };
  }
  const parsed = parseDumpConfig(dump, packageName);
  if (parsed.level === "warning") {
    return {
      ...parsed,
      packageName,
      ran: true,
      summary: `its patch is applied, but ${parsed.missingEntries.length} plugin row(s) reference missing entries — those features may not work.`,
    };
  }
  if (parsed.level === "ok") {
    return {
      ...parsed,
      packageName,
      ran: true,
      summary: "loaded and its config patch is active in the headless profile.",
    };
  }
  return {
    ...parsed,
    packageName,
    ran: true,
    summary:
      "installed as a plain dependency, not activated (declares no dsh.bundle.patch). It is not loaded by the headless profile.",
  };
}
