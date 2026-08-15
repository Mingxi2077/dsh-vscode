import * as fs from "fs";
import * as path from "path";
import { isZh } from "./i18n";

/** 项目记忆文件位置（工作区根目录下 .dsh/memory.md，与仓库共存、透明可版本化）。 */
const MEMORY_REL = path.join(".dsh", "memory.md");
/** 拼入任务文本的记忆最大字符数。 */
const MAX_MEMORY_CHARS = 20000;

/** 按工作区目录管理的长期记忆：追加式 Markdown 文件，每次任务自动注入。 */
export class ProjectMemory {
  constructor(private readonly workspaceRoot: string) {}

  private file(): string {
    return path.join(this.workspaceRoot, MEMORY_REL);
  }

  exists(): boolean {
    return fs.existsSync(this.file());
  }

  read(): string {
    try {
      return fs.readFileSync(this.file(), "utf8");
    } catch {
      return "";
    }
  }

  /** 追加一条带时间戳的记忆（tmp+rename 原子写，避免与 agent 并发写坏文件）。 */
  append(text: string): void {
    const file = this.file();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString(isZh() ? "zh-CN" : "en-US", { hour12: false });
    const entry = `## ${stamp}\n${text.trim()}\n`;
    const existing = this.read().trim();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, existing ? `${existing}\n${entry}` : entry, "utf8");
    fs.renameSync(tmp, file);
  }

  /** 拼入任务文本用的记忆摘要（带截断保护）。 */
  excerpt(maxChars: number = MAX_MEMORY_CHARS): string {
    const content = this.read().trim();
    if (!content) return "";
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + (isZh() ? "\n…(记忆内容过长，已截断)" : "\n…(memory too long, truncated)");
  }
}
