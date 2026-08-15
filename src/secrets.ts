import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 按环境变量名管理的密钥存储：值放在 VS Code SecretStorage（系统密钥链），
 * 名字索引放在 globalStorage（SecretStorage 不支持枚举）。
 */
export class SecretStore {
  private static readonly PREFIX = "dsh.env.";

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly indexFile: string
  ) {}

  private index(): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private saveIndex(names: string[]): void {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...new Set(names)]), "utf8");
    fs.renameSync(tmp, this.indexFile);
  }

  async get(name: string): Promise<string | undefined> {
    return this.secrets.get(SecretStore.PREFIX + name);
  }

  async set(name: string, value: string): Promise<void> {
    await this.secrets.store(SecretStore.PREFIX + name, value);
    const idx = this.index();
    if (!idx.includes(name)) {
      idx.push(name);
      this.saveIndex(idx);
    }
  }

  async delete(name: string): Promise<void> {
    await this.secrets.delete(SecretStore.PREFIX + name);
    this.saveIndex(this.index().filter((n) => n !== name));
  }

  /** 全部已存密钥 → 环境变量映射（供子进程注入）。 */
  async envSecrets(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of this.index()) {
      const value = await this.secrets.get(SecretStore.PREFIX + name);
      if (value) out[name] = value;
    }
    return out;
  }
}
