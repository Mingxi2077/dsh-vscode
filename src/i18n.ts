import * as vscode from "vscode";

/**
 * 轻量 i18n：按 VS Code 界面语言返回中文/英文文案。
 * 用于扩展侧（extension host）的用户可见消息（systemMessage、提示、状态栏）。
 * Webview 前端（media/chat.js）用自己的一套 I18N 字典。
 */

/** 是否中文界面。 */
export function isZh(): boolean {
  return vscode.env.language.toLowerCase().startsWith("zh");
}

/** 双语选择：zh 优先，否则 en。 */
export function t(zh: string, en: string): string {
  return isZh() ? zh : en;
}

/** 带占位符的模板：{0} {1} 替换。 */
export function tf(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}
