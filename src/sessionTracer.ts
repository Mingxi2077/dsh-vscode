import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** 归一化后的流式进度消息（发送给 Webview 展示思维链 / 工具调用）。 */
export type ProgressMessage =
  | { kind: "turn"; turn: number }
  | { kind: "step"; turn: number; step: number; active: boolean }
  | { kind: "tool"; callId: string; name: string; args: string }
  | { kind: "tool-result"; callId: string; isError: boolean; summary: string }
  | { kind: "reasoning"; key: string; index: number; text: string }
  | { kind: "text"; key: string; index: number; text: string }
  | { kind: "assistant"; blocks: AssistantBlock[] }
  | { kind: "usage"; input: number; output: number; cacheRead: number; reasoning: number; model: string; provider: string }
  | { kind: "done"; turn: number; reason: string }
  | { kind: "title"; title: string }
  | { kind: "block"; key: string; blockType: "reasoning" | "text" | "tool-call"; text?: string; name?: string; args?: string; callId?: string };

export interface AssistantBlock {
  type: "reasoning" | "text" | "tool-call";
  text?: string;
  name?: string;
  arguments?: string;
}

interface JsonlRecord {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 把 DSH 会话事件日志（明文 JSONL）实时 tail 成进度消息。
 * 会话目录结构：$DSH_HOME/sessions-vscode/<bucket>/session-<uuid>/session.jsonl */
export class SessionTracer {
  private readonly sessionsDir: string;
  private readonly snapshot: Set<string>;
  private readonly log?: (line: string) => void;
  private finished = false;
  private eventsParsed = 0;
  private found = false;
  private usageAcc: { input: number; output: number; cacheRead: number; reasoning: number; model: string; provider: string } | undefined;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly startedAt: number,
    log?: (line: string) => void
  ) {
    this.log = log;
    const home = env.DSH_HOME || path.join(os.homedir(), ".dsh");
    // 与 patch/stream.patch.yml 的 root 保持一致：独立根目录，避免与历史 zstd 日志冲突
    this.sessionsDir = path.join(home, "sessions-vscode");
    this.snapshot = new Set(this.listLogFiles());
    this.log?.(`流式：会话目录 ${this.sessionsDir}，已有 ${this.snapshot.size} 个明文日志`);
  }

  /** 追踪结果统计（供诊断）。 */
  stats(): { found: boolean; eventsParsed: number } {
    return { found: this.found, eventsParsed: this.eventsParsed };
  }

  /** 进程结束后调用：再排空一次剩余记录即结束 tail。 */
  finish(): void {
    this.finished = true;
  }

  private listLogFiles(): string[] {
    try {
      return walkFiles(this.sessionsDir).filter((f) => path.basename(f) === "session.jsonl");
    } catch {
      return [];
    }
  }

  /** 等待本次任务产生的会话日志文件并持续推送进度。失败时静默结束（不影响主流程）。 */
  async start(onMessage: (msg: ProgressMessage) => void, signal: AbortSignal): Promise<void> {
    try {
      const file = await this.waitForLogFile(signal);
      if (!file || signal.aborted) return;
      this.found = true;
      this.log?.(`流式：找到会话日志 ${file}`);
      await this.tail(file, onMessage, signal);
      this.log?.(`流式：结束，共解析 ${this.eventsParsed} 条事件`);
    } catch {
      // 流式是增强功能：任何失败都静默降级，最终答复仍从 stdout 获取
      this.log?.("流式：异常，已静默降级");
    }
  }

  /** 轮询等待 spawn 之后新建的 session.jsonl（上限 30s）。 */
  private async waitForLogFile(signal: AbortSignal): Promise<string | undefined> {
    const deadline = Date.now() + 30000;
    while (!signal.aborted && Date.now() < deadline) {
      const now = new Set(this.listLogFiles());
      for (const f of now) {
        if (!this.snapshot.has(f)) {
          try {
            const st = fs.statSync(f);
            if (st.mtimeMs >= this.startedAt - 1000) return f;
          } catch {
            // 文件可能刚被清理
          }
        }
      }
      await sleep(200);
    }
    return undefined;
  }

  /** 从偏移继续读取追加行并解析。 */
  private async tail(
    file: string,
    onMessage: (msg: ProgressMessage) => void,
    signal: AbortSignal
  ): Promise<void> {
    let offset = 0;
    let buffer = "";

    while (!signal.aborted) {
      let data: Buffer | undefined;
      try {
        data = fs.readFileSync(file);
      } catch {
        // 文件暂时不可读（写入中/重命名），稍后重试
        await sleep(150);
        continue;
      }
      if (data.length < offset) {
        // 文件被截断/重建：从头重读
        offset = 0;
        buffer = "";
      }
      const chunk = data.toString("utf8", offset);
      offset = data.length;
      buffer += chunk;

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = this.parseLine(line);
        if (msg) {
          this.eventsParsed += 1;
          onMessage(msg);
        }
      }

      if (signal.aborted) return;
      if (this.finished) {
        // 排空剩余记录（含未换行的残行）后结束
        await sleep(300);
        try {
          const data = fs.readFileSync(file);
          const rest = buffer + data.toString("utf8", offset);
          buffer = "";
          for (const line of rest.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) {
              const msg = this.parseLine(trimmed);
              if (msg) {
                this.eventsParsed += 1;
                onMessage(msg);
              }
            }
          }
        } catch {
          // 忽略收尾读取失败
        }
        return;
      }
      await sleep(150);
    }
  }

  private parseLine(line: string): ProgressMessage | undefined {
    let record: JsonlRecord;
    try {
      record = JSON.parse(line) as JsonlRecord;
    } catch {
      return undefined;
    }
    const data = (record.data ?? {}) as Record<string, any>;
    switch (record.type) {
      case "session":
        return undefined; // 头记录
      case "turn/start":
        return { kind: "turn", turn: Number(data.turn) };
      case "turn/end":
        return { kind: "done", turn: Number(data.turn), reason: String(data.reason?.kind ?? "completed") };
      case "step/start":
        return { kind: "step", turn: Number(data.turn), step: Number(data.step), active: true };
      case "step/end":
        return { kind: "step", turn: Number(data.turn), step: Number(data.step), active: false };
      case "session/title": {
        // DSH 生成的会话标题；fallback 标题（截断式）跳过，用 LLM 生成的
        const sourceKind = String(data.source?.kind ?? "");
        if (sourceKind === "fallback") return undefined;
        const title = String(data.title ?? "").trim();
        if (!title) return undefined;
        return { kind: "title", title };
      }
      case "assistant/chunk": {
        // 流式块事件：只消费 block-end（权威完整块），delta 碎片稀疏且与
        // reasoning-chunks/text-chunks 重叠，避免双写
        const chunk = data.chunk ?? {};
        if (chunk.type !== "block-end") return undefined;
        const key = `${data.turn ?? 0}:${data.step ?? 0}:${chunk.index ?? 0}`;
        const block = chunk.block ?? {};
        if (block.type === "reasoning") {
          const text = String(block.text ?? "");
          return text ? { kind: "block", key, blockType: "reasoning" as const, text } : undefined;
        }
        if (block.type === "text") {
          const text = String(block.text ?? "");
          return text ? { kind: "block", key, blockType: "text" as const, text } : undefined;
        }
        if (block.type === "tool-call") {
          return {
            kind: "block",
            key,
            blockType: "tool-call" as const,
            name: String(block.name ?? "tool"),
            args: summarizeArgs(block.arguments),
            callId: String(block.id ?? ""),
          };
        }
        return undefined;
      }
      case "tool/call":
        return {
          kind: "tool",
          callId: String(data.callId ?? ""),
          name: String(data.name ?? "tool"),
          args: summarizeArgs(data.arguments),
        };
      case "tool/result": {
        const isError = !!data.message?.isError;
        const summary = summarizeToolResult(data.message);
        return {
          kind: "tool-result",
          callId: String(data.callId ?? ""),
          isError,
          summary,
        };
      }
      case "reasoning-chunks": {
        const texts: string[] = Array.isArray(data.texts) ? data.texts : [];
        const key = `${data.turn ?? 0}:${data.step ?? 0}:${data.index ?? 0}`;
        return { kind: "reasoning", key, index: Number(data.index ?? 0), text: texts.join("") };
      }
      case "text-chunks": {
        const texts: string[] = Array.isArray(data.texts) ? data.texts : [];
        const key = `${data.turn ?? 0}:${data.step ?? 0}:${data.index ?? 0}`;
        return { kind: "text", key, index: Number(data.index ?? 0), text: texts.join("") };
      }
      case "tool-call-chunks": {
        const args: string[] = Array.isArray(data.args) ? data.args : [];
        return {
          kind: "tool",
          callId: String(data.id ?? ""),
          name: String(data.name ?? "tool"),
          args: args.join("").slice(0, 400),
        };
      }
      case "assistant/message": {
        const blocks = parseAssistantBlocks(data.message);
        if (blocks.length === 0) return undefined;
        // 用量累计：把本次消息的 usage 合并进累计值并随事件下发
        const u = data.usage;
        if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
          const acc = this.usageAcc ?? { input: 0, output: 0, cacheRead: 0, reasoning: 0, model: "", provider: "" };
          acc.input += Number(u.inputTokens ?? 0);
          acc.output += Number(u.outputTokens ?? 0);
          acc.cacheRead += Number(u.cacheReadTokens ?? 0);
          acc.reasoning += Number(u.reasoningTokens ?? 0);
          acc.model = String(data.message?.source?.model ?? acc.model);
          acc.provider = String(data.message?.source?.provider ?? acc.provider);
          this.usageAcc = acc;
          return { kind: "usage", ...acc };
        }
        return { kind: "assistant", blocks };
      }
      default:
        return undefined;
    }
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeArgs(raw: unknown): string {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return (s ?? "").slice(0, 400);
}

function summarizeToolResult(message: any): string {
  try {
    const content = message?.content ?? [];
    for (const block of content) {
      if (block.type !== "tool-result") continue;
      const parts: string[] = [];
      for (const inner of block.content ?? []) {
        if (inner.type === "text") parts.push(inner.text);
      }
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 300);
    }
  } catch {
    // 忽略解析问题
  }
  return "";
}

function parseAssistantBlocks(message: any): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (block.type === "reasoning" && typeof block.text === "string") {
      blocks.push({ type: "reasoning", text: block.text });
    } else if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool-call") {
      blocks.push({
        type: "tool-call",
        name: String(block.name ?? "tool"),
        arguments: summarizeArgs(block.arguments),
      });
    }
  }
  return blocks;
}
