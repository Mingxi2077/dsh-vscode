import * as path from "path";
import * as vscode from "vscode";
import type { ContextBlockInput } from "./taskText";
import { t, tf } from "./i18n";
export type { ContextBlockInput, MemorySource } from "./taskText";

export function relPath(folderPath: string, absPath: string): string {
  const rel = path.relative(folderPath, absPath);
  return rel.startsWith("..") ? absPath : rel;
}

/** 从回答内容中提取第一段代码块；没有代码块时返回 undefined（避免把整段回答当代码插入）。 */
export function extractCodeForInsert(content: string): string | undefined {
  const match = content.match(/```[\s\S]*?\n([\s\S]*?)```/);
  return match ? match[1].replace(/\n$/, "") : undefined;
}

/** 把代码插入当前编辑器光标处。 */
export function insertCodeToEditor(code: string): void {
  const editor = resolveActiveEditor();
  if (!editor) {
    void vscode.window.showWarningMessage(t("没有打开的编辑器可插入代码。", "No open editor to insert code into."));
    return;
  }
  void editor
    .edit((editBuilder) => {
      const pos = editor.selection.active;
      editBuilder.insert(pos, code.endsWith("\n") ? code : code + "\n");
    })
    .then(undefined, () => {
      void vscode.window.showWarningMessage(t("插入代码失败（编辑器可能已被关闭）。", "Failed to insert code (the editor may have been closed)."));
    });
}

/** 把当前编辑器选中内容作为上下文块回调出去。 */
export function attachActiveSelection(
  folderPath: string,
  onBlock: (block: ContextBlockInput) => void
): void {
  const editor = resolveActiveEditor();
  if (!editor) {
    void vscode.window.showWarningMessage(
      t("当前没有打开的编辑器。请先在编辑器中打开一个文件，或改用「📄 当前文件」并在弹窗中选择文件。", "No editor open. Open a file in the editor first, or use \"📄 Current file\" and pick a file in the dialog.")
    );
    return;
  }
  if (editor.selection.isEmpty) {
    void vscode.window.showWarningMessage(t("请先在编辑器中选中一段代码。", "Select some code in the editor first."));
    return;
  }
  const doc = editor.document;
  const content = doc.getText(editor.selection);
  const label = relPath(folderPath, doc.uri.fsPath) + t("（选中）", " (selected)");
  onBlock({ kind: "selection", label, content });
}

/** 把当前打开文件的内容作为上下文块回调出去（截断保护）。
 * 聊天面板聚焦时 activeTextEditor 可能为空，先退回任意可见编辑器；再不行就弹文件选择器。 */
export function attachOpenFile(
  folderPath: string,
  onBlock: (block: ContextBlockInput) => void
): void {
  const editor = resolveActiveEditor();
  if (!editor) {
    void vscode.window.showWarningMessage(t("当前没有打开的编辑器，请在下方对话框中选择要加入的文件。", "No editor open; pick the file to attach in the dialog below."));
    void pickAndAttachFile(folderPath, onBlock);
    return;
  }
  const doc = editor.document;
  let content = doc.getText();
  const label = relPath(folderPath, doc.uri.fsPath);
  if (content.length > 40000) {
    content = content.slice(0, 40000) + t("\n…(文件过大，已截断)", "\n…(file too large, truncated)");
  }
  onBlock({ kind: "file", label, content });
}

/** 聊天面板/webview 聚焦时 activeTextEditor 可能为 undefined：退回可见编辑器。 */
function resolveActiveEditor(): vscode.TextEditor | undefined {
  return vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
}

async function pickAndAttachFile(
  folderPath: string,
  onBlock: (block: ContextBlockInput) => void
): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectMany: false,
    canSelectFolders: false,
    openLabel: t("加入为上下文", "Attach as context"),
    defaultUri: vscode.Uri.file(folderPath),
  });
  if (!uris || uris.length === 0) return;
  const uri = uris[0];
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    let content = Buffer.from(buf).toString("utf8");
    const label = relPath(folderPath, uri.fsPath);
    if (content.length > 40000) {
      content = content.slice(0, 40000) + t("\n…(文件过大，已截断)", "\n…(file too large, truncated)");
    }
    onBlock({ kind: "file", label, content });
  } catch {
    void vscode.window.showWarningMessage(tf(t("无法读取文件：{0}", "Cannot read file: {0}"), uri.fsPath));
  }
}

/** 从回答内容中提取第一段代码块；没有代码块时返回全文。 */
