import { spawn, execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { t, tf } from "./i18n";

/**
 * 解析后的 dsh 启动方式。
 * - command 模式：直接启动可执行文件（POSIX 的 shim / 用户显式配置）。
 * - entry 模式：用 node 启动 @deepseek-ai/dsh 的 JS 入口，绕过 Windows cmd.exe 转发的参数引号问题。
 */
export type ResolvedCli =
  | { kind: "entry"; node: string; entry: string; source: string }
  | { kind: "command"; command: string; source: string };

export interface DshRunOptions {
  /** 工作目录，即 agent 的项目根目录 */
  cwd: string;
  /** 超时毫秒数 */
  timeoutMs: number;
  /** 子进程环境变量（已包含 process.env 与用户额外配置） */
  env: NodeJS.ProcessEnv;
  /** 取消信号（用户点击取消） */
  signal?: AbortSignal;
}

export interface DshRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** 默认的 dsh 包内入口相对路径（npm 全局安装布局下固定） */
const ENTRY_REL = path.join(
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js"
);

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 15000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(tf(t("{0} 执行失败: {1}", "{0} failed: {1}"), file, (stderr || err.message).trim())));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function firstLine(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const out = await execFileAsync(cmd, args);
    const line = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line;
  } catch {
    return undefined;
  }
}

/** 解析用于启动 dsh 的 node：优先 PATH 上的 node（与 dsh shim 一致），兜底用扩展宿主自己的 node。 */
async function resolveNodeBinary(): Promise<string> {
  const isWin = process.platform === "win32";
  const found = await firstLine(isWin ? "where.exe" : "which", ["node"]);
  if (found) return found;
  return process.execPath;
}

/** 从 PATH 定位 dsh，并尽量解析出真实的 node 入口以规避 Windows cmd.exe 引号问题。 */
export async function resolveCli(cliPath?: string): Promise<ResolvedCli> {
  if (cliPath && cliPath.trim().length > 0) {
    const p = path.resolve(cliPath.trim());
    if (!fs.existsSync(p)) {
      throw new Error(`配置的 dsh-harness-vscode.cliPath 不存在: ${p}`);
    }
    if (p.toLowerCase().endsWith(".js")) {
      return { kind: "entry", node: await resolveNodeBinary(), entry: p, source: "配置(dsh-harness-vscode.cliPath)" };
    }
    return { kind: "command", command: p, source: "配置(dsh-harness-vscode.cliPath)" };
  }

  const isWin = process.platform === "win32";

  if (isWin) {
    // Windows: where dsh 找到 .cmd/.ps1 shim，其所在目录是全局 node prefix，
    // 包入口固定为 <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js。
    const shim = await firstLine("where.exe", ["dsh"]);
    if (shim) {
      const prefix = path.dirname(shim);
      const entry = path.join(prefix, ENTRY_REL);
      if (fs.existsSync(entry)) {
        return { kind: "entry", node: await resolveNodeBinary(), entry, source: `PATH 解析(${shim})` };
      }
      return { kind: "command", command: shim, source: `PATH 解析(${shim})` };
    }
    // 兜底：pnpm 全局等非标准布局下 where 拿不到，尝试常见全局位置。
    const npmRoot = await firstLine("npm.cmd", ["root", "-g"]);
    if (npmRoot) {
      const entry = path.join(npmRoot.trim(), ENTRY_REL);
      if (fs.existsSync(entry)) {
        return { kind: "entry", node: await resolveNodeBinary(), entry, source: "npm root -g 解析" };
      }
    }
  } else {
    const found = await firstLine("which", ["dsh"]);
    if (found) {
      return { kind: "command", command: found, source: `PATH 解析(${found})` };
    }
  }

  throw new Error(
    t(
      "未找到 dsh 命令。请确认已全局安装 @deepseek-ai/dsh（npm i -g @deepseek-ai/dsh），或在设置中配置 dsh-harness-vscode.cliPath。",
      'dsh command not found. Install @deepseek-ai/dsh globally (npm i -g @deepseek-ai/dsh), or set dsh-harness-vscode.cliPath in settings.'
    )
  );
}

/** 构造 spawn 参数（不含 node 本身，可执行文件由调用方单独传入）。
 * entry 模式附加 --expose-internals：DSH 的 HMR 服务在 node < 24 时必须带该 flag
 * 才能访问内部模块加载器（node >= 24 可走原生插件兜底，带上 flag 无副作用）。 */
export function buildSpawnArgs(cli: ResolvedCli, extraArgs: string[], task: string): string[] {
  const base = ["--profile", "headless", ...extraArgs, task];
  if (cli.kind === "entry") {
    return ["--expose-internals", cli.entry, ...base];
  }
  return base;
}

/** 查询 dsh 版本（launcher 的 --version），用于环境自检。 */
export function runCliVersion(cli: ResolvedCli): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = cli.kind === "entry" ? [cli.entry, "--version"] : ["--version"];
    const child = spawn(cli.kind === "entry" ? cli.node : cli.command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(t("查询 dsh 版本超时", "Timed out querying the dsh version")));
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(tf(t("无法启动 dsh：{0}", "Failed to launch dsh: {0}"), err.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(tf(t("dsh --version 失败(exit {0}): {1}", "dsh --version failed (exit {0}): {1}"), code ?? "?", stderr.trim() || stdout.trim())));
      }
    });
  });
}

/** 运行一次 dsh headless 任务，收集 stdout/stderr，直到进程退出、超时或被取消。 */
export function runDsh(
  cli: ResolvedCli,
  args: string[],
  options: DshRunOptions
): Promise<DshRunResult> {
  return new Promise((resolve) => {
    // 防御：参数里绝不能包含可执行文件自身（否则 node 会把 exe 当脚本解析）
    if (cli.kind === "entry" && (args[0] === cli.node || args[0] === cli.entry)) {
      resolve({
        stdout: "",
        stderr: tf(t("内部错误：spawn 参数包含了可执行文件自身（{0}）", "Internal error: spawn args contain the executable itself ({0})"), args[0]),
        code: 1,
        signal: null,
        timedOut: false,
      });
      return;
    }
    // spawn 前检查：取消若发生在 CLI/环境解析期间，signal 已 aborted——直接返回取消结果，
    // 避免 spawn 后新增的 abort 监听永不触发、子进程无法被杀（仅靠超时兜底）
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "", code: null, signal: "SIGTERM", timedOut: false });
      return;
    }
    const child = spawn(cli.kind === "entry" ? cli.node : cli.command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code, signal, timedOut });
    };

    const onAbort = () => {
      child.kill();
    };

    options.signal?.addEventListener("abort", onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += tf(t("spawn 失败: {0}", "spawn failed: {0}"), err.message) + "\n";
      finish(null, null);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
