import * as vscode from "vscode";
import * as path from "path";
import {
  FEATURED_PLUGINS,
  PluginInfo,
  InstalledPlugin,
  PluginCommandResult,
  readInstalledPlugins,
  runPluginCommand,
  featuredPlugin,
  isInstalled,
  installSourceKind,
  githubShortToHttps,
  resolveInstalledName,
} from "./pluginManager";
import { ResolvedCli } from "./cli";
import { t } from "./i18n";
import { checkPluginHeadless, HeadlessCheckResult } from "./headlessCheck";
import { PluginWatch } from "./pluginWatch";

/** 插件中心免责声明（醒目、诚恳、严谨，防止第三方插件在 headless 下不生效引发纠纷）。 */
const COMPAT_NOTICE = t(
  `⚠️ 兼容性说明：DSH 插件生态基于官方 Web 端设计，本扩展通过 headless 命令行使用 DSH。插件能否在这里生效，取决于其实现——工具类插件通常可用；依赖 Web 界面、外部 API 或特定宿主的插件可能不生效。安装后扩展会自动检测插件「能否被 DSH 加载」并标注结果，但该检测只保证加载层面，不保证功能完全可用，也不代表官方支持。安装第三方插件前请自行评估来源可信度与使用风险。`,
  `⚠️ Compatibility notice: the DSH plugin ecosystem is designed for the official Web client; this extension drives DSH through the headless CLI. Whether a plugin works here depends on its implementation — tool plugins usually do, while plugins relying on Web UI, external APIs, or specific hosts may not. After install, the extension auto-checks whether the plugin loads and labels the result, but that check only covers the loading layer — it does not guarantee full functionality, nor is it an official endorsement. Please evaluate the trustworthiness and risk of third-party plugins yourself.`
);

/** 携带自定义负载的 QuickPick 项（action / packageName 不是标准字段，用接口扩展）。 */
interface PluginPickItem extends vscode.QuickPickItem {
  action?: string;
  packageName?: string;
  sourceKind?: string;
}

/** 手动安装后用于把包名标记为「已检测」的 context（openPluginCenter 注入；避免哨兵重复通知）。 */
let watchContext: vscode.ExtensionContext | undefined;

/** 插件中心：浏览精选插件、查看已装状态、一键安装/卸载。 */
export async function openPluginCenter(cliProvider: () => Promise<ResolvedCli>, context?: vscode.ExtensionContext): Promise<void> {
  if (context) watchContext = context;
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
      { label: "$(info) " + t("⚠️ 兼容性说明（重要，请阅读）", "⚠️ Compatibility notice (important, please read)"), description: t("第三方插件与 headless 的适配边界", "How third-party plugins fit the headless CLI"), action: "compat-notice" },
      // 操作入口放最顶部，避免被列表淹没
      { label: "$(cloud-download) " + t("从来源安装…", "Install from source…"), description: t("npm 包名 / GitHub 仓库 / git URL / 本地路径", "npm package / GitHub repo / git URL / local path"), action: "install-source" },
      { label: "$(refresh) " + t("刷新列表", "Refresh"), description: t("重新读取 headless profile 已装插件", "Reload installed plugins from the headless profile"), action: "refresh" },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: t("📦 已安装插件", "📦 Installed plugins"), kind: vscode.QuickPickItemKind.Separator },
      ...installed.map((p) => makeInstalledItem(p)),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: t("✨ 精选可装插件", "✨ Featured installable"), kind: vscode.QuickPickItemKind.Separator },
      ...FEATURED_PLUGINS.filter((p) => !installedNames.has(p.packageName)).map((p) => makeFeaturedItem(p)),
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
  if (action === "compat-notice") {
    void vscode.window.showWarningMessage(COMPAT_NOTICE, { modal: true });
    await showPluginBrowser(cli);
    return;
  }
  if (action === "install-source") {
    await installFromSource(cli);
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
    description: `[${t(p.category, p.categoryEn ?? p.category)}]`,
    detail: t(p.description, p.descriptionEn ?? p.description),
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
    actions.push({ label: "$(beaker) " + t("检测兼容性", "Check headless compatibility"), description: t("用 DSH 运行时验证加载情况", "Verify loading via the DSH runtime"), action: "check" });
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
      ? `**${feat.displayName}**（\`${feat.packageName}\`）\n\n${t(feat.description, feat.descriptionEn ?? feat.description)}\n\n- ${t("分类", "Category")}：${t(feat.category, feat.categoryEn ?? feat.category)}\n- ${t("类型", "Type")}：${feat.bundle ? t("bundle（安装即激活）", "bundle (activates on install)") : t("普通依赖", "plain dependency")}\n- ${t("状态", "Status")}：${inst ? (inst.active ? t("已激活", "active") : t("已安装未激活", "installed, inactive")) : t("未安装", "not installed")}`
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
    return;
  }
  if (action === "check") {
    await runCompatibilityCheck(cli, packageName);
    await showPluginActions(cli, packageName, installed);
  }
}

/** 手动执行 headless 兼容性检测并展示结果（含边界说明）。 */
async function runCompatibilityCheck(cli: ResolvedCli, packageName: string): Promise<void> {
  const check = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("正在检测 {0} 的 headless 兼容性…", "Checking headless compatibility of {0}…").replace("{0}", packageName) },
    () => checkPluginHeadless(cli, packageName)
  );
  const label = compatCheckLabel(check);
  const body =
    check.level === "ok"
      ? t(
          `✅ ${packageName} 已加载，且其配置补丁在 headless profile 中生效。注意：这仅证明「能加载」，不代表所有功能都可用——依赖外部 API 或 UI 组件的功能仍需自行验证。`,
          `✅ ${packageName} is loaded and its config patch is active in the headless profile. Note: this only proves it "loads" — features depending on external APIs or UI components still need your own verification.`
        )
      : check.level === "warning"
      ? t(
          `⚠️ ${packageName} 已加载，但其补丁引用了 ${check.missingEntries.length} 个缺失插件行，部分功能可能不生效。`,
          `⚠️ ${packageName} is loaded, but its patch references ${check.missingEntries.length} missing plugin row(s) — some features may not work.`
        )
      : check.level === "inactive"
      ? t(
          `⚪ ${packageName} 仅作为普通依赖安装（未声明 dsh.bundle.patch），headless profile 不会加载它。`,
          `⚪ ${packageName} is installed as a plain dependency only (no dsh.bundle.patch), so the headless profile does not load it.`
        )
      : t(`❌ 检测未能完成：${check.summary}`, `❌ The check could not complete: ${check.summary}`);
  void vscode.window.showInformationMessage(label + "\n\n" + body, { modal: true });
}

/** 从任意来源安装插件：npm 包名 / GitHub 仓库 / git URL / 本地路径。 */
async function installFromSource(cli: ResolvedCli): Promise<void> {
  const kindPick = await vscode.window.showQuickPick(
    [
      { label: t("npm 包名", "npm package name"), description: t("如 dsh-plugin-doctor", "e.g. dsh-plugin-doctor"), sourceKind: "npm" },
      { label: t("GitHub 仓库", "GitHub repo"), description: t("如 github:owner/repo 或 owner/repo", "e.g. github:owner/repo or owner/repo"), sourceKind: "github" },
      { label: t("git URL / tarball URL", "git URL / tarball URL"), description: t("如 git+https://… 或 https://…/*.tgz", "e.g. git+https://… or https://…/*.tgz"), sourceKind: "url" },
      { label: t("本地路径", "Local path"), description: t("如 ./my-plugin 或 C:\\plugins\\x", "e.g. ./my-plugin or C:\\plugins\\x"), sourceKind: "path" },
    ] as PluginPickItem[],
    { placeHolder: t("选择安装来源", "Choose an install source") }
  );
  if (!kindPick) return;
  const kind = kindPick.sourceKind as string;

  const input = await vscode.window.showInputBox({
    prompt: t("输入插件来源", "Enter the plugin source"),
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim().length > 0 ? undefined : t("不能为空", "cannot be empty")),
  });
  if (!input) return;

  const source = input.trim();
  // github 短名（github:owner/repo 或 owner/repo）统一转成显式 git+https URL：
  // pnpm 对 github: 协议可能解析成 git+ssh://，本机无 ssh key 时 clone 失败（exit 128）
  const resolvedSource =
    kind === "github" && !source.startsWith("http")
      ? githubShortToHttps(source)
      : source;
  const detected = installSourceKind(resolvedSource);
  const kindLabel =
    kind === "github"
      ? t("GitHub 仓库", "GitHub repo")
      : { npm: t("npm 包", "npm package"), github: t("GitHub 仓库", "GitHub repo"), "git-url": t("git URL", "git URL"), url: t("URL", "URL"), path: t("本地路径", "local path") }[detected];

  // 本地路径：pnpm 在 profile 目录执行，相对路径会相对 ~/.dsh/profiles/headless 解析——
  // 这里把相对路径基于当前工作区转成绝对路径，避免装到错误位置。
  // 若用户显式选择了「本地路径」但输入的是裸名（如 my-plugin，无 ./ 或盘符），
  // 也按本地路径处理，而不是静默当成 npm 包安装。
  let finalSource = resolvedSource;
  const isPathIntent = kind === "path";
  if ((detected === "path" || isPathIntent) && !path.isAbsolute(finalSource)) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage(
        t("相对路径需要先打开一个工作区文件夹；请改用绝对路径。", "A relative local path requires an open workspace folder; use an absolute path instead.")
      );
      return;
    }
    finalSource = path.resolve(root, finalSource);
  }

  const confirm = await vscode.window.showWarningMessage(
    t(
      `将从「${kindLabel}」安装 ${finalSource} 到 headless profile。⚠️ 第三方插件可能包含仅适用于官方 Web 端的组件，在 headless 下可能不生效；安装后扩展会自动检测并提示。继续？`,
      `Install ${finalSource} from "${kindLabel}" into the headless profile? ⚠️ Third-party plugins may contain components for the official Web client only, which may not work under headless; the extension will auto-check and report after install. Continue?`
    ),
    { modal: true },
    t("安装", "Install")
  );
  if (confirm !== t("安装", "Install")) return;

  const { res, check } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("正在安装并检测 {0}…", "Installing & checking {0}…").replace("{0}", finalSource) },
    async () => {
      const r = await runPluginCommand(cli, "add", finalSource);
      if (!r.ok) return { res: r, check: undefined as HeadlessCheckResult | undefined };
      const realName = resolveInstalledName(finalSource);
      const c = await checkPluginHeadless(cli, realName);
      if (watchContext) void new PluginWatch(watchContext).markChecked([realName]);
      return { res: r, check: c };
    }
  );
  notifyPluginResult(cli, finalSource, res, check);
}

/** 兼容性检测结果的简短标签（双语）。 */
function compatCheckLabel(check: HeadlessCheckResult): string {
  switch (check.level) {
    case "ok":
      return t("✅ 兼容性检测：已加载并生效", "✅ Compatibility: loaded & active");
    case "warning":
      return t("⚠️ 兼容性检测：已加载但有警告（部分可能不生效）", "⚠️ Compatibility: loaded with warnings (some parts may not work)");
    case "inactive":
      return t("⚪ 兼容性检测：仅安装未激活", "⚪ Compatibility: installed, inactive");
    default:
      return t("❌ 兼容性检测失败", "❌ Compatibility check failed");
  }
}

/** 展示插件操作结果。可靠性策略：
 * 1) 状态栏消息（15s）——不依赖通知系统，必定可见；
 * 2) 成功弹带「查看插件中心」按钮的通知（带按钮不自动消失），失败弹错误通知；
 * 3) 若提供了 headless 检测结果，附加一行兼容性标签。 */
function notifyPluginResult(cli: ResolvedCli, pkg: string, res: PluginCommandResult, check?: HeadlessCheckResult): void {
  const text = localizePluginResult(pkg, res);
  const suffix = check ? `\n${compatCheckLabel(check)}` : "";
  vscode.window.setStatusBarMessage(text + (check ? ` · ${compatCheckLabel(check)}` : ""), 15000);
  if (res.ok) {
    void vscode.window.showInformationMessage(text + suffix, t("查看插件中心", "Open Plugin Center")).then((pick) => {
      if (pick === t("查看插件中心", "Open Plugin Center")) {
        void showPluginBrowser(cli);
      }
    });
  } else {
    void vscode.window.showErrorMessage(text + suffix);
  }
}

/** 翻译 runPluginCommand 的英文返回消息为当前语言（成功/失败都翻译）。 */
function localizePluginResult(pkg: string, res: { ok: boolean; message: string; active?: boolean; kind?: string; missingDep?: string; detail?: string }): string {
  const msg = res.message;
  // 成功
  if (res.ok) {
    if (msg.startsWith("installed")) {
      return t("已安装 {0}", "Installed {0}").replace("{0}", pkg) + (res.active === true ? t("（已激活）", " (activated)") : t("（可能未激活）", " (may not be activated)"));
    }
    if (msg.startsWith("removed")) {
      return t("已卸载 {0}", "Removed {0}").replace("{0}", pkg);
    }
    return msg;
  }
  // 失败
  if (res.kind === "dep404") {
    const dep = res.missingDep ? `"${res.missingDep}"` : t("某个依赖", "a dependency");
    const body = res.detail ? `\n\n${res.detail}` : "";
    return t(
      `安装 ${pkg} 失败：依赖 ${dep} 未发布到 npm（404），当前无法安装。请反馈给插件作者，或换用其它插件。${body}`,
      `Installing ${pkg} failed: dependency ${dep} is not published on npm (404), so it cannot be installed right now. Report it to the plugin author or try another plugin.${body}`
    );
  }
  if (res.kind === "network") {
    const body = res.detail ? `\n\n${res.detail}` : "";
    return t(
      `插件操作失败：网络错误，无法连接 npm 仓库。请检查网络/代理后重试。${body}`,
      `Plugin operation failed: network error while contacting the npm registry. Check your connection/proxy and retry.${body}`
    );
  }
  if (msg.startsWith("install") && msg.includes("build-script permission")) {
    return t(
      `安装 ${pkg} 需要 build 脚本许可但自动处理失败。请重试，或查看 DSH 输出面板。`,
      `Installing ${pkg} needs build-script permission (onlyBuiltDependencies) but auto-handling failed. Retry, or check the DSH output panel.`
    );
  }
  if (msg.startsWith("plugin command timed out")) {
    return t(`插件命令超时：{0}`, "Plugin command timed out: {0}").replace("{0}", pkg);
  }
  if (msg.startsWith("spawn failed")) {
    return t(`无法启动 dsh：{0}`, "Failed to launch dsh: {0}").replace("{0}", msg.replace("spawn failed: ", ""));
  }
  if (msg.startsWith("install") || msg.startsWith("remove")) {
    // 通用失败：保留英文细节（原始错误），前缀本地化
    return t(`插件操作失败：{0}`, "Plugin operation failed: {0}").replace("{0}", msg);
  }
  return msg;
}

async function installPlugin(cli: ResolvedCli, packageName: string): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    t(
      `将安装插件 ${packageName} 到 headless profile（~/.dsh/profiles/headless）。⚠️ 第三方插件可能包含仅适用于官方 Web 端的组件，在 headless 下可能不生效；安装后扩展会自动检测并提示。继续？`,
      `Install plugin ${packageName} into the headless profile (~/.dsh/profiles/headless)? ⚠️ Third-party plugins may contain components for the official Web client only, which may not work under headless; the extension will auto-check and report after install. Continue?`
    ),
    { modal: true },
    t("安装", "Install")
  );
  if (confirm !== t("安装", "Install")) return;
  const { res, check } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("正在安装并检测 {0}…", "Installing & checking {0}…").replace("{0}", packageName) },
    async () => {
      const r = await runPluginCommand(cli, "add", packageName);
      if (!r.ok) return { res: r, check: undefined as HeadlessCheckResult | undefined };
      const c = await checkPluginHeadless(cli, packageName);
      if (watchContext) void new PluginWatch(watchContext).markChecked([packageName]);
      return { res: r, check: c };
    }
  );
  notifyPluginResult(cli, packageName, res, check);
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
  notifyPluginResult(cli, packageName, progress);
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
