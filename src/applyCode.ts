import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { CodeBlock } from "./codeBlocks";
import { resolveForCreateInsideRoot } from "./pathSafety";
import { t, tf } from "./i18n";

/** 确认并把代码块写入文件。 */
export async function applyCodeBlock(folderPath: string, block: CodeBlock): Promise<void> {
  const root = path.resolve(folderPath);
  if (block.pathHint) {
    const target = path.resolve(root, block.pathHint);
    const rel = path.relative(root, target);
    // realpath 复核：写目标可能尚不存在，从最近的已存在祖先验证仍在工作区内，
    // 防止通过区外符号链接把模型生成的代码写到工作区之外
    const safe = resolveForCreateInsideRoot(root, target);
    const within = safe.ok && !!safe.realPath;
    const resolved = safe.realPath ?? target;
    const exists = within && fs.existsSync(resolved);
    if (within && exists) {
      try {
        if (fs.statSync(resolved).isDirectory()) {
          void vscode.window.showWarningMessage(
            tf(t("目标 {0} 是目录，无法直接写入，请另存为新文件。", "Target {0} is a directory; use “Save as new file” instead."), rel)
          );
          return;
        }
      } catch {
        // stat 失败按不存在处理，下面会走创建流程
      }
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: exists ? tf(t("覆盖 {0}", "Overwrite {0}"), rel) : tf(t("创建 {0}", "Create {0}"), rel), apply: "write" },
        { label: t("另存为新文件…", "Save as new file…"), description: "", apply: "save-as" },
      ],
      { placeHolder: tf(t("应用到文件：{0}", "Apply to file: {0}"), block.pathHint) }
    );
    if (!action) return;

    if (action.apply === "save-as") {
      await saveAs(folderPath, block);
      return;
    }
    if (!within || !resolved) {
      void vscode.window.showWarningMessage(
        tf(t("出于安全，拒绝写入工作区外的文件：{0}", "Refusing to write outside the workspace for security: {0}"), block.pathHint)
      );
      return;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, block.code.endsWith("\n") ? block.code : block.code + "\n", "utf8");
    const doc = await vscode.window.showTextDocument(vscode.Uri.file(resolved));
    void doc;
    void vscode.window.showInformationMessage(tf(t("已写入 {0}", "Written to {0}"), rel));
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
