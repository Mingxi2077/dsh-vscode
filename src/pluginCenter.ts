import * as vscode from "vscode";
import {
  FEATURED_PLUGINS,
  PluginInfo,
  InstalledPlugin,
  readInstalledPlugins,
  runPluginCommand,
  featuredPlugin,
  isInstalled,
} from "./pluginManager";
import { ResolvedCli } from "./cli";

/** 携带自定义负载的 QuickPick 项（action / packageName 不是标准字段，用接口扩展）。 */
interface PluginPickItem extends vscode.QuickPickItem {
  action?: string;
  packageName?: string;
}

/** 插件中心：浏览精选插件、查看已装状态、一键安装/卸载。 */
export async function openPluginCenter(cliProvider: () => Promise<ResolvedCli>): Promise<void> {
  try {
    const cli = await cliProvider();
    await showPluginBrowser(cli);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`插件中心：无法解析 dsh 命令：${message}`);
  }
}

/** 主浏览界面：已装插件 + 精选可装插件，带安装/卸载/详情动作。 */
async function showPluginBrowser(cli: ResolvedCli): Promise<void> {
  const installed = readInstalledPlugins();
  const installedNames = new Set(installed.map((p) => p.packageName));

  const pick = await vscode.window.showQuickPick(
    [
      { label: "📦 已安装插件", kind: vscode.QuickPickItemKind.Separator },
      ...installed.map((p) => makeInstalledItem(p)),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "✨ 精选可装插件", kind: vscode.QuickPickItemKind.Separator },
      ...FEATURED_PLUGINS.filter((p) => !installedNames.has(p.packageName)).map((p) => makeFeaturedItem(p)),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(refresh) 刷新列表", description: "重新读取 headless profile 已装插件", action: "refresh" },
    ] as PluginPickItem[],
    {
      placeHolder: "DSH 插件中心：选择插件或操作",
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  if (!pick) return;
  const action = pick.action as string | undefined;
  const pkg = pick.packageName as string | undefined;

  if (action === "refresh") {
    await showPluginBrowser(cli);
    return;
  }
  if (!pkg) return;
  await showPluginActions(cli, pkg, installed);
}

function makeInstalledItem(p: InstalledPlugin): PluginPickItem {
  const feat = featuredPlugin(p.packageName);
  return {
    label: `${p.active ? "🟢" : "⚪"} ${feat?.displayName ?? p.packageName}`,
    description: p.active ? "已激活" : "未激活（非 bundle）",
    detail: `${p.packageName}${p.version ? ` · v${p.version}` : ""}${feat ? ` — ${feat.description}` : ""}`,
    packageName: p.packageName,
  };
}

function makeFeaturedItem(p: PluginInfo): PluginPickItem {
  return {
    label: `⬇ ${p.displayName}`,
    description: `[${p.category}]`,
    detail: p.description,
    packageName: p.packageName,
  };
}

/** 单个插件的操作菜单：详情 / 安装 / 卸载 / 返回。 */
async function showPluginActions(cli: ResolvedCli, packageName: string, installed: InstalledPlugin[]): Promise<void> {
  const feat = featuredPlugin(packageName);
  const inst = installed.find((p) => p.packageName === packageName);
  const actions: PluginPickItem[] = [
    { label: "$(arrow-left) 返回插件列表", action: "back" },
  ];
  if (inst) {
    actions.push({ label: "$(trash) 卸载", description: inst.active ? "从 profile 移除并停用" : "从依赖移除", action: "rm" });
  } else {
    actions.push({
      label: "$(cloud-download) 安装",
      description: feat?.bundle ? "bundle 插件，安装即激活" : "普通依赖（可能不激活）",
      action: "add",
    });
  }
  actions.push({ label: "$(info) 详情", action: "detail" });

  const pick = await vscode.window.showQuickPick(actions, { placeHolder: `${feat?.displayName ?? packageName}` });
  if (!pick) return;
  const action = pick.action as string;
  if (action === "back") {
    await showPluginBrowser(cli);
    return;
  }
  if (action === "detail") {
    const text = feat
      ? `**${feat.displayName}**（\`${feat.packageName}\`）\n\n${feat.description}\n\n- 分类：${feat.category}\n- 类型：${feat.bundle ? "bundle（安装即激活）" : "普通依赖"}\n- 状态：${inst ? (inst.active ? "已激活" : "已安装未激活") : "未安装"}`
      : `**${packageName}**\n\n- 非精选插件\n- 状态：${inst ? (inst.active ? "已激活" : "已安装未激活") : "未安装"}`;
    void vscode.window.showInformationMessage(text, { modal: true });
    await showPluginActions(cli, packageName, installed);
    return;
  }
  if (action === "add") {
    await installPlugin(cli, packageName);
    return;
  }
  if (action === "rm") {
    await uninstallPlugin(cli, packageName);
  }
}

async function installPlugin(cli: ResolvedCli, packageName: string): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `将安装插件 ${packageName} 到 headless profile（~/.dsh/profiles/headless）。安装后需重载窗口使新工具生效。继续？`,
    { modal: true },
    "安装"
  );
  if (confirm !== "安装") return;
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在安装 ${packageName}…` },
    async () => runPluginCommand(cli, "add", packageName)
  );
  if (progress.ok) {
    void vscode.window.showInformationMessage(
      `${progress.message}${progress.active === true ? "（已激活，重载窗口后生效）" : "（注意：可能未激活）"}`
    );
  } else {
    void vscode.window.showErrorMessage(progress.message);
  }
}

async function uninstallPlugin(cli: ResolvedCli, packageName: string): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `将卸载插件 ${packageName}（从 headless profile 移除）。继续？`,
    { modal: true },
    "卸载"
  );
  if (confirm !== "卸载") return;
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在卸载 ${packageName}…` },
    async () => runPluginCommand(cli, "rm", packageName)
  );
  if (progress.ok) {
    void vscode.window.showInformationMessage(`${progress.message}（重载窗口后生效）`);
  } else {
    void vscode.window.showErrorMessage(progress.message);
  }
}

/** 供"检查环境"输出插件状态。 */
export function pluginStatusSummary(): string[] {
  const installed = readInstalledPlugins();
  if (installed.length === 0) return ["headless profile 无额外插件（仅官方 bundles）"];
  return installed.map((p) => {
    const feat = featuredPlugin(p.packageName);
    return `${p.active ? "🟢" : "⚪"} ${feat?.displayName ?? p.packageName} (${p.packageName})${p.active ? " 已激活" : " 未激活"}`;
  });
}

/** 已安装插件名（供外部判断是否装了某个插件）。 */
export function isPluginInstalled(packageName: string): boolean {
  return isInstalled(packageName);
}
