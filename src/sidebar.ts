import * as vscode from "vscode";
import { loadSelection, readDefaultEffort } from "./modelSelection";
import { ProjectMemory } from "./memory";
import { stableHash } from "./sessionStore";

/** 侧边栏状态刷新事件（ChatPanel 改变选择后调用）。 */
const emitter = new vscode.EventEmitter<StatusItem | undefined>();
export function refreshSidebarStatus(): void {
  emitter.fire(undefined);
}

class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    opts: { command?: string; icon?: string; description?: string } = {}
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (opts.command) {
      this.command = { command: opts.command, title: label };
    }
    if (opts.icon) {
      this.iconPath = new vscode.ThemeIcon(opts.icon);
    }
    if (opts.description) {
      this.description = opts.description;
    }
    this.contextValue = opts.command ? "action" : "status";
  }
}

class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
  readonly onDidChangeTreeData: vscode.Event<StatusItem | undefined> = emitter.event;

  constructor(private readonly globalStorageDir: string) {}

  getTreeItem(element: StatusItem): StatusItem {
    return element;
  }

  getChildren(): StatusItem[] {
    const items: StatusItem[] = [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    const sel = folder ? loadSelection(this.globalStorageDir, stableHash(folder.uri.fsPath)) : undefined;
    const mode = vscode.workspace.getConfiguration("dsh-harness-vscode").get<string>("permissionMode", "workspace-write");
    const mem = folder ? new ProjectMemory(folder.uri.fsPath) : undefined;

    items.push(new StatusItem(`模型：${sel?.model ?? "DSH 默认"}`, { icon: "symbol-method" }));
    items.push(
      new StatusItem(`思维强度：${sel?.reasoningEffort ?? readDefaultEffort() ?? "未设置"}`, {
        icon: "symbol-property",
      })
    );
    items.push(new StatusItem(`沙箱：${mode}`, { icon: "shield" }));
    items.push(new StatusItem(mem?.exists() ? "记忆：已记录" : "记忆：空", { icon: "note" }));
    items.push(new StatusItem("", {}));

    items.push(new StatusItem("打开对话", { command: "dsh-harness-vscode.openChat", icon: "comment-discussion" }));
    items.push(new StatusItem("新建会话", { command: "dsh-harness-vscode.newSession", icon: "add" }));
    items.push(new StatusItem("检查环境", { command: "dsh-harness-vscode.checkEnvironment", icon: "search" }));
    items.push(new StatusItem("兼容性自检", { command: "dsh-harness-vscode.selfTest", icon: "beaker" }));
    items.push(new StatusItem("查看记忆", { command: "dsh-harness-vscode.showMemory", icon: "note" }));
    items.push(new StatusItem("编辑记忆", { command: "dsh-harness-vscode.editMemory", icon: "edit" }));

    return items;
  }
}

/** 注册侧边栏状态视图。 */
export function registerSidebarView(context: vscode.ExtensionContext): vscode.TreeView<StatusItem> {
  const provider = new StatusTreeProvider(context.globalStorageUri.fsPath);
  const view = vscode.window.createTreeView("dsh-harness-vscode.status", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  // 可见时刷新，保证状态是最新的
  view.onDidChangeVisibility((e) => {
    if (e.visible) refreshSidebarStatus();
  });
  return view;
}
