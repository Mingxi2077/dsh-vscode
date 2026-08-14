import * as fs from "fs";
import * as path from "path";

export type ChatRole = "user" | "assistant" | "system";

/** 思维链轨迹块：保留回答背后的思考过程与工具调用，可折叠展示。 */
export type TraceBlock =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; args: string; result?: string; isError?: boolean }
  | { kind: "goal"; objective: string; operation: string };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** 生成该回答时的思维链轨迹（思考 + 工具调用），可选。 */
  trace?: TraceBlock[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** DSH 生成的会话标题（session/title 事件）；存在时不再用首条消息截断覆盖。 */
  dshTitle?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** 轻量但稳定的字符串哈希，用于按工作区目录分桶存储会话。 */
export function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** 会话持久化：每个工作区目录一个子目录，会话按 JSON 文件存储。 */
export class SessionStore {
  private readonly root: string;

  constructor(globalStorageDir: string, folderPath: string) {
    this.root = path.join(globalStorageDir, "sessions", stableHash(folderPath));
    fs.mkdirSync(this.root, { recursive: true });
  }

  private fileFor(id: string): string {
    // 只允许会话 id 使用安全字符，防止路径穿越。
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`非法会话 id: ${id}`);
    }
    return path.join(this.root, `${id}.json`);
  }

  list(): SessionSummary[] {
    if (!fs.existsSync(this.root)) return [];
    const items: SessionSummary[] = [];
    for (const name of fs.readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      try {
        const session = this.load(path.basename(name, ".json"));
        if (session) {
          items.push({
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length,
          });
        }
      } catch {
        // 单个损坏文件不阻塞会话列表
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  }

  load(id: string): ChatSession | undefined {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return undefined;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as ChatSession;
      if (!parsed.id || !Array.isArray(parsed.messages)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  save(session: ChatSession): void {
    session.updatedAt = Date.now();
    fs.writeFileSync(this.fileFor(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  remove(id: string): void {
    const file = this.fileFor(id);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}
