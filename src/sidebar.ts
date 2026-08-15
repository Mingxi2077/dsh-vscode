import * as vscode from "vscode";
import { loadSelection, readDefaultEffort } from "./modelSelection";
import { agentModeById } from "./agentModes";
import { ProjectMemory } from "./memory";
import { stableHash } from "./sessionStore";
import { t } from "./i18n";

/** 侧边栏状态刷新事件（ChatPanel 改变选择后调用）。 */
const emitter = new vscode.EventEmitter<StatusItem | undefined>();
export function refreshSidebarStatus(): void {
  emitter.fire(undefined);
}

/** 当前运行的扩展版本号。 */
function currentVersion(): string {
  try {
    return vscode.extensions.getExtension("mingxi2077.dsh-harness-vscode")?.packageJSON.version ?? t("未知", "unknown");
  } catch {
    return t("未知", "unknown");
  }
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
    const sandbox = vscode.workspace.getConfiguration("dsh-harness-vscode").get<string>("permissionMode", "workspace-write");
    const mem = folder ? new ProjectMemory(folder.uri.fsPath) : undefined;
    const modeInfo = agentModeById(sel?.mode);

    items.push(new StatusItem(`${t("模型", "Model")}：${sel?.model ?? t("DSH 默认", "DSH default")}`, { icon: "symbol-method" }));
    items.push(
      new StatusItem(`${t("思维强度", "Effort")}：${sel?.reasoningEffort ?? readDefaultEffort() ?? t("未设置", "not set")}`, {
        icon: "symbol-property",
      })
    );
    items.push(
      new StatusItem(`${t("Agent 模式（新会话）", "Agent mode (new session)")}：${modeInfo ? t(modeInfo.name, modeInfo.nameEn) : t("默认组装", "default composition")}`, {
        icon: "symbol-class",
      })
    );
    items.push(new StatusItem(`${t("沙箱", "Sandbox")}：${sandbox}`, { icon: "shield" }));
    items.push(new StatusItem(mem?.exists() ? t("记忆：已记录", "Memory: set") : t("记忆：空", "Memory: empty"), { icon: "note" }));
    items.push(new StatusItem(`${t("扩展", "Extension")}：v${currentVersion()}`, { icon: "versions" }));
    items.push(new StatusItem("", {}));

    items.push(new StatusItem(t("打开对话", "Open Chat"), { command: "dsh-harness-vscode.openChat", icon: "comment-discussion" }));
    items.push(new StatusItem(t("新建会话", "New Session"), { command: "dsh-harness-vscode.newSession", icon: "add" }));
    items.push(new StatusItem(t("插件中心", "Plugin Center"), { command: "dsh-harness-vscode.pluginCenter", icon: "extensions" }));
    items.push(new StatusItem(t("模式预设", "Mode Presets"), { command: "dsh-harness-vscode.presetCenter", icon: "settings-gear" }));
    items.push(new StatusItem(t("检查环境", "Check Environment"), { command: "dsh-harness-vscode.checkEnvironment", icon: "search" }));
    items.push(new StatusItem(t("兼容性自检", "Self-Test"), { command: "dsh-harness-vscode.selfTest", icon: "beaker" }));
    items.push(new StatusItem(t("查看记忆", "View Memory"), { command: "dsh-harness-vscode.showMemory", icon: "note" }));
    items.push(new StatusItem(t("编辑记忆", "Edit Memory"), { command: "dsh-harness-vscode.editMemory", icon: "edit" }));

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
