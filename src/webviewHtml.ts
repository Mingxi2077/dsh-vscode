import * as crypto from "crypto";
import * as path from "path";
import * as vscode from "vscode";

/**
 * 生成聊天面板的 Webview HTML。
 * CSP 使用 nonce 限制脚本来源，资源仅允许来自本扩展的 media 目录。
 */
export function renderChatHtml(webview: vscode.Webview, extensionPath: string): string {
  const nonce = randomNonce();
  const media = webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, "media")));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`,
    "font-src 'none'",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DSH</title>
<link rel="stylesheet" href="${media}/chat.css">
<link rel="stylesheet" href="${media}/live.css">
</head>
<body>
  <header id="header">
    <div class="session-info">
      <span id="session-title">DSH</span>
      <span id="session-id" class="muted"></span>
    </div>
    <div class="actions">
      <button id="btn-sessions" class="icon-btn" title="历史会话">🕘</button>
      <button id="btn-new" class="icon-btn" title="新建会话">＋</button>
    </div>
  </header>
  <main id="messages"></main>
  <footer id="composer">
    <div id="usage-bar" class="usage-bar" hidden></div>
    <div id="context-bar"></div>
    <textarea id="input" rows="3" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
    <div id="composer-row">
      <button id="btn-attach" class="ghost-btn" title="把当前选中代码加入上下文">📎 选中代码</button>
      <button id="btn-file" class="ghost-btn" title="把当前打开文件加入上下文">📄 当前文件</button>
      <span id="status" class="muted"></span>
      <button id="btn-cancel" class="danger-btn" hidden>取消</button>
      <button id="btn-send" class="primary-btn">发送</button>
    </div>
  </footer>
<script nonce="${nonce}" src="${media}/markdown.js"></script>
<script nonce="${nonce}" src="${media}/chat.js"></script>
</body>
</html>`;
}

function randomNonce(): string {
  return crypto.randomUUID();
}
