import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 一个可用的技能（目录 + frontmatter 元信息）。 */
export interface SkillInfo {
  name: string;
  description: string;
  root: string;
}

/** 扫描技能根目录（用户级 ~/.dsh/skills 与项目级 <project>/.dsh/skills）。 */
export function listSkills(projectRoot: string): SkillInfo[] {
  const roots = [
    path.join(os.homedir(), ".dsh", "skills"),
    path.join(projectRoot, ".dsh", "skills"),
  ];
  const out: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const dir = path.join(root, entry.name);
      const info = readSkillInfo(dir, entry.name);
      if (info) {
        seen.add(entry.name);
        out.push(info);
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readSkillInfo(dir: string, fallbackName: string): SkillInfo | undefined {
  for (const candidate of ["SKILL.md", "skill.md"]) {
    const file = path.join(dir, candidate);
    try {
      const raw = fs.readFileSync(file, "utf8");
      const name = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
      const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
      return { name, description, root: dir };
    } catch {
      // 尝试下一个文件名
    }
  }
  return undefined;
}
