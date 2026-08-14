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
import { t } from "./i18n";

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
      { label: t("📦 已安装插件", "📦 Installed plugins"), kind: vscode.QuickPickItemKind.Separator },
      ...installed.map((p) => makeInstalledItem(p)),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: t("✨ 精选可装插件", "✨ Featured installable"), kind: vscode.QuickPickItemKind.Separator },
      ...FEATURED_PLUGINS.filter((p) => !installedNames.has(p.packageName)).map((p) => makeFeaturedItem(p)),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(refresh) " + t("刷新列表", "Refresh"), description: t("重新读取 headless profile 已装插件", "Reload installed plugins from the headless profile"), action: "refresh" },
    ] as PluginPickItem[],
    {
      placeHolder: t("DSH 插件中心：选择插件或操作", "DSH Plugin Center: choose a plugin or action"),
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
    description: p.active ? t("已激活", "active") : t("未激活（非 bundle）", "inactive (non-bundle)"),
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
    { label: "$(arrow-left) " + t("返回插件列表", "Back to list"), action: "back" },
  ];
  if (inst) {
    actions.push({ label: "$(trash) " + t("卸载", "Uninstall"), description: inst.active ? t("从 profile 移除并停用", "Remove and deactivate from profile") : t("从依赖移除", "Remove from dependencies"), action: "rm" });
  } else {
    actions.push({
      label: "$(cloud-download) " + t("安装", "Install"),
      description: feat?.bundle ? t("bundle 插件，安装即激活", "bundle plugin, activates on install") : t("普通依赖（可能不激活）", "plain dependency (may not activate)"),
      action: "add",
    });
  }
  actions.push({ label: "$(info) " + t("详情", "Details"), action: "detail" });

  const pick = await vscode.window.showQuickPick(actions, { placeHolder: `${feat?.displayName ?? packageName}` });
  if (!pick) return;
  const action = pick.action as string;
  if (action === "back") {
    await showPluginBrowser(cli);
    return;
  }
  if (action === "detail") {
    const text = feat
      ? `**${feat.displayName}**（\`${feat.packageName}\`）\n\n${feat.description}\n\n- ${t("分类", "Category")}：${feat.category}\n- ${t("类型", "Type")}：${feat.bundle ? t("bundle（安装即激活）", "bundle (activates on install)") : t("普通依赖", "plain dependency")}\n- ${t("状态", "Status")}：${inst ? (inst.active ? t("已激活", "active") : t("已安装未激活", "installed, inactive")) : t("未安装", "not installed")}`
      : `**${packageName}**\n\n- ${t("非精选插件", "not a featured plugin")}\n- ${t("状态", "Status")}：${inst ? (inst.active ? t("已激活", "active") : t("已安装未激活", "installed, inactive")) : t("未安装", "not installed")}`;
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
    t(
      `将安装插件 ${packageName} 到 headless profile（~/.dsh/profiles/headless）。安装后需重载窗口使新工具生效。继续？`,
      `Install plugin ${packageName} into the headless profile (~/.dsh/profiles/headless)? Reload the window after install for new tools to take effect. Continue?`
    ),
    { modal: true },
    t("安装", "Install")
  );
  if (confirm !== t("安装", "Install")) return;
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("正在安装 {0}…", "Installing {0}…").replace("{0}", packageName) },
    async () => runPluginCommand(cli, "add", packageName)
  );
  if (progress.ok) {
    void vscode.window.showInformationMessage(
      `${progress.message}${progress.active === true ? t("（已激活，重载窗口后生效）", " (activated, effective after window reload)") : t("（注意：可能未激活）", " (note: may not be activated)")}`
    );
  } else {
    void vscode.window.showErrorMessage(progress.message);
  }
}

async function uninstallPlugin(cli: ResolvedCli, packageName: string): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    t(
      `将卸载插件 ${packageName}（从 headless profile 移除）。继续？`,
      `Uninstall plugin ${packageName} (remove from the headless profile)? Continue?`
    ),
    { modal: true },
    t("卸载", "Uninstall")
  );
  if (confirm !== t("卸载", "Uninstall")) return;
  const progress = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("正在卸载 {0}…", "Uninstalling {0}…").replace("{0}", packageName) },
    async () => runPluginCommand(cli, "rm", packageName)
  );
  if (progress.ok) {
    void vscode.window.showInformationMessage(`${progress.message}${t("（重载窗口后生效）", " (effective after window reload)")}`);
  } else {
    void vscode.window.showErrorMessage(progress.message);
  }
}

/** 供"检查环境"输出插件状态。 */
export function pluginStatusSummary(): string[] {
  const installed = readInstalledPlugins();
  if (installed.length === 0) return [t("headless profile 无额外插件（仅官方 bundles）", "No extra plugins in the headless profile (official bundles only)")];
  return installed.map((p) => {
    const feat = featuredPlugin(p.packageName);
    return `${p.active ? "🟢" : "⚪"} ${feat?.displayName ?? p.packageName} (${p.packageName})${p.active ? t(" 已激活", " active") : t(" 未激活", " inactive")}`;
  });
}

/** 已安装插件名（供外部判断是否装了某个插件）。 */
export function isPluginInstalled(packageName: string): boolean {
  return isInstalled(packageName);
}
