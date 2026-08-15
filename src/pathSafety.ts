import * as fs from "fs";
import * as path from "path";

/**
 * 工作区边界安全工具：仅做 path.resolve 前缀判断可被工作区内的符号链接绕过
 * （symlink 指向区外时，目标文件并不在真实工作区树内）。这里统一用 realpath 复核。
 */

/** 判断 realPath 是否仍在 realRoot 内。 */
function isInside(realRoot: string, realPath: string): boolean {
  const rel = path.relative(realRoot, realPath);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

export interface PathSafetyResult {
  ok: boolean;
  /** 已解析到真实路径后的目标（仅 ok=true 时有意义）。 */
  realPath?: string;
}

/** 解析一个「必须已存在」的目标：任何一级是区外 symlink 都拒绝。 */
export function resolveExistingInsideRoot(root: string, candidate: string): PathSafetyResult {
  try {
    const realRoot = fs.realpathSync.native(path.resolve(root));
    const realTarget = fs.realpathSync.native(path.resolve(candidate));
    if (isInside(realRoot, realTarget)) return { ok: true, realPath: realTarget };
  } catch {
    // 目标不存在或不可访问，按不安全处理（调用方应给出明确提示）
  }
  return { ok: false };
}

/** 解析一个「可能还不存在」的待创建目标：从最近的已存在祖先做 realpath 复核，再拼接缺失段。 */
export function resolveForCreateInsideRoot(root: string, candidate: string): PathSafetyResult {
  try {
    const realRoot = fs.realpathSync.native(path.resolve(root));
    const target = path.resolve(candidate);
    const missing: string[] = [];
    let probe = target;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false };
      missing.unshift(path.basename(probe));
      probe = parent;
    }
    const realBase = fs.realpathSync.native(probe);
    if (!isInside(realRoot, realBase)) return { ok: false };
    return { ok: true, realPath: path.join(realBase, ...missing) };
  } catch {
    return { ok: false };
  }
}
