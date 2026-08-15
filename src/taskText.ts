import type { ChatSession } from "./sessionStore";

/** 上下文块的输入形状（label 为展示名，content 为内容片段）。 */
export interface ContextBlockInput {
  kind: "file" | "selection";
  label: string;
  content: string;
}

/** 记忆来源的最小接口（便于测试）。 */
export interface MemorySource {
  excerpt(maxChars?: number): string;
}

/** 把会话历史、上下文块、项目记忆拼装成发给 headless 的任务文本。
 * @param zh 是否中文界面（决定注入给 agent 的指令语言，进而影响回复语言）。 */
export function buildTaskText(
  folderPath: string,
  session: ChatSession,
  contextBlocks: ContextBlockInput[],
  memory: MemorySource,
  historyMessages: number,
  maxMessageChars: number,
  extraSections: string[] = [],
  zh = true
): string {
  const lines: string[] = [];
  lines.push(
    zh
      ? "你在 VS Code 中通过 DSH 辅助用户完成项目任务。"
      : "You are assisting the user with a project task in VS Code via DSH."
  );
  lines.push(zh ? `项目根目录：${folderPath}` : `Project root: ${folderPath}`);
  lines.push(
    zh
      ? "请只回应最新一条用户消息，不要复述历史对话或客套。"
      : "Only respond to the latest user message; do not restate history or be polite."
  );

  if (extraSections.length > 0) {
    lines.push("");
    lines.push(zh ? "--- 会话配置 ---" : "--- Session config ---");
    lines.push(...extraSections);
  }

  // 项目长期记忆：每次任务自动注入
  const memoryText = memory.excerpt();
  if (memoryText) {
    lines.push("");
    lines.push(zh ? "--- 项目长期记忆（之前会话积累的项目知识，按需参考）---" : "--- Project long-term memory (accumulated project knowledge; reference as needed) ---");
    lines.push(memoryText);
  }

  if (contextBlocks.length > 0) {
    lines.push("");
    lines.push(zh ? "以下是用户提供的上下文内容，回答时按需参考：" : "The following context was provided by the user; reference it as needed:");
    for (const block of contextBlocks) {
      lines.push(`@${block.label}`);
      let content = block.content;
      if (content.length > maxMessageChars) {
        content = content.slice(0, maxMessageChars) + (zh ? "\n…(内容已截断)" : "\n…(content truncated)");
      }
      lines.push(content);
      lines.push("");
    }
  }

  // historyMessages=0 表示禁用历史注入；slice(-0) 会返回整个数组，需显式处理
  const hist = historyMessages > 0 ? session.messages.slice(0, -1).slice(-historyMessages * 2) : [];
  if (hist.length > 0) {
    lines.push(zh ? "--- 历史对话 ---" : "--- Conversation history ---");
    for (const m of hist) {
      const label = zh
        ? m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统"
        : m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
      let content = m.content;
      if (content.length > maxMessageChars) content = content.slice(0, maxMessageChars) + (zh ? "\n…(已截断)" : "\n…(truncated)");
      lines.push(`${label}: ${content}`);
    }
  }

  const last = session.messages[session.messages.length - 1];
  if (!last) return lines.join("\n"); // 防御：空会话时不要引用 undefined
  lines.push(zh ? "--- 最新用户消息 ---" : "--- Latest user message ---");
  lines.push(last.content);
  return lines.join("\n");
}
