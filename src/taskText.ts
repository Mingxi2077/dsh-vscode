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

/** 把会话历史、上下文块、项目记忆拼装成发给 headless 的任务文本。 */
export function buildTaskText(
  folderPath: string,
  session: ChatSession,
  contextBlocks: ContextBlockInput[],
  memory: MemorySource,
  historyMessages: number,
  maxMessageChars: number,
  extraSections: string[] = []
): string {
  const lines: string[] = [];
  lines.push("你在 VS Code 中通过 DSH 辅助用户完成项目任务。");
  lines.push(`项目根目录：${folderPath}`);
  lines.push("请只回应最新一条用户消息，不要复述历史对话或客套。");

  if (extraSections.length > 0) {
    lines.push("");
    lines.push("--- 会话配置 ---");
    lines.push(...extraSections);
  }

  // 项目长期记忆：每次任务自动注入
  const memoryText = memory.excerpt();
  if (memoryText) {
    lines.push("");
    lines.push("--- 项目长期记忆（之前会话积累的项目知识，按需参考）---");
    lines.push(memoryText);
  }

  if (contextBlocks.length > 0) {
    lines.push("");
    lines.push("以下是用户提供的上下文内容，回答时按需参考：");
    for (const block of contextBlocks) {
      lines.push(`@${block.label}`);
      let content = block.content;
      if (content.length > maxMessageChars) {
        content = content.slice(0, maxMessageChars) + "\n…(内容已截断)";
      }
      lines.push(content);
      lines.push("");
    }
  }

  const hist = session.messages.slice(0, -1).slice(-historyMessages * 2);
  if (hist.length > 0) {
    lines.push("--- 历史对话 ---");
    for (const m of hist) {
      const label = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
      let content = m.content;
      if (content.length > maxMessageChars) content = content.slice(0, maxMessageChars) + "\n…(已截断)";
      lines.push(`${label}: ${content}`);
    }
  }

  const last = session.messages[session.messages.length - 1];
  lines.push("--- 最新用户消息 ---");
  lines.push(last.content);
  return lines.join("\n");
}
