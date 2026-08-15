import * as os from "os";
import * as path from "path";

/**
 * 统一的 DSH_HOME 解析：
 * 1) 扩展激活时注入的覆盖值（来自 dsh-harness-vscode.environment.DSH_HOME 配置），
 *    与注入给 dsh 子进程的 DSH_HOME 保持一致；
 * 2) 扩展宿主进程的 DSH_HOME 环境变量；
 * 3) 兜底 ~/.dsh。
 *
 * 该模块不 require vscode（Node 单测可直接使用）；覆盖值由 extension.ts 在激活和
 * 配置变更时调用 setDshHome 注入。
 */

let override: string | undefined;

/** 设置 DSH_HOME 覆盖（undefined 或空串表示回到环境变量/默认值）。 */
export function setDshHome(home: string | undefined): void {
  override = home && home.trim() ? path.resolve(home.trim()) : undefined;
}

/** 当前生效的 DSH_HOME 根目录。 */
export function dshHome(): string {
  if (override) return override;
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) return path.resolve(process.env.DSH_HOME.trim());
  return path.join(os.homedir(), ".dsh");
}

/** 拼接 DSH_HOME 下的相对路径。 */
export function dshHomePath(...parts: string[]): string {
  return path.join(dshHome(), ...parts);
}
