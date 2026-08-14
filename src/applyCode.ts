import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { CodeBlock } from "./codeBlocks";
import { t } from "./i18n";

/** 确认并把代码块写入文件。 */
export async function applyCodeBlock(folderPath: string, block: CodeBlock): Promise<void> {
  const root = path.resolve(folderPath);
  if (block.pathHint) {
    const target = path.resolve(root, block.pathHint);
    const rel = path.relative(root, target);
    const within = target === root || target.startsWith(root + path.sep);
    const exists = within && fs.existsSync(target);

    const action = await vscode.window.showQuickPick(
      [
        { label: exists ? `覆盖 ${rel}` : `创建 ${rel}` },
        { label: "另存为新文件…", description: "" },
      ],
      { placeHolder: `应用到文件：${block.pathHint}` }
    );
    if (!action) return;

    if (action.label === "另存为新文件…") {
      await saveAs(folderPath, block);
      return;
    }
    if (!within) {
      void vscode.window.showWarningMessage(`出于安全，拒绝写入工作区外的文件：${block.pathHint}`);
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, block.code.endsWith("\n") ? block.code : block.code + "\n", "utf8");
    const doc = await vscode.window.showTextDocument(vscode.Uri.file(target));
    void doc;
    void vscode.window.showInformationMessage(`已写入 ${rel}`);
  } else {
    await saveAs(folderPath, block);
  }
}

async function saveAs(folderPath: string, block: CodeBlock): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(folderPath),
    saveLabel: t("写入", "Write"),
  });
  if (!uri) return;
  fs.writeFileSync(uri.fsPath, block.code.endsWith("\n") ? block.code : block.code + "\n", "utf8");
  await vscode.window.showTextDocument(uri);
}
