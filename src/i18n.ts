/**
 * 轻量 i18n：按 VS Code 界面语言返回中文/英文文案。
 * 用于扩展侧（extension host）的用户可见消息（systemMessage、提示、状态栏）。
 * Webview 前端（media/chat.js）用自己的一套 I18N 字典。
 *
 * 设计：模块**不**在顶层 require("vscode")——便于 Node 单测（node:test 无 vscode 模块）。
 * 语言来源：优先 setUiLanguage 注入的缓存值（extension 激活时设置），
 * 兜底惰性 require vscode，再兜底 "en"。
 */

let uiLang: string | undefined;

/** 扩展激活时注入 UI 语言（如 vscode.env.language），单测可用 setUiLanguage("en") 覆盖。 */
export function setUiLanguage(lang: string): void {
  uiLang = lang;
}

function guessLanguage(): string {
  if (uiLang) return uiLang;
  try {
    // 惰性 require：Node 单测环境没有 vscode 模块，捕获后回退 "en"
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode") as { env?: { language?: string } };
    return vscode.env?.language ?? "en";
  } catch {
    return "en";
  }
}

/** 是否中文界面。 */
export function isZh(): boolean {
  return guessLanguage().toLowerCase().startsWith("zh");
}

/** 双语选择：zh 优先，否则 en。 */
export function t(zh: string, en: string): string {
  return isZh() ? zh : en;
}

/** 带占位符的模板：{0} {1} 替换。 */
export function tf(template: string, ...args: (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}
