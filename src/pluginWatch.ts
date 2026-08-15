import * as vscode from "vscode";
import { readInstalledPlugins, findNewPlugins, OFFICIAL_BUNDLES } from "./pluginManager";
import { checkPluginHeadless, compatLevelIcon } from "./headlessCheck";
import { ResolvedCli } from "./cli";
import { t } from "./i18n";

/**
 * 插件"哨兵"：监控 headless profile 中新增的、尚未做兼容性检测的插件。
 *
 * 背景：用户可能通过三种途径安装插件——插件中心 UI（自带确认+检测）、聊天中让
 * DSH agent 直接执行 `dsh plugin add`（绕过 UI 检测）、或手动改 profile。无论哪种
 * 途径，只要 profile 里出现未检测过的插件，本模块就自动补一次兼容性检测并提醒，
 * 保证"能加载与否"的客观结论始终覆盖到每个插件。
 *
 * 检测记录存在 vscode globalState（key: dsh.checkedPlugins.v1），跨工作区共享
 * （headless profile 是全局的）。
 */

export class PluginWatch {
  private static readonly KEY = "dsh.checkedPlugins.v1";

  constructor(private readonly context: vscode.ExtensionContext) {}

  private checked(): string[] {
    return this.context.globalState.get<string[]>(PluginWatch.KEY, []);
  }

  /** 检测一次新插件；没有新插件时完全静默。返回检测到的新插件数。 */
  async checkOnce(cli: ResolvedCli): Promise<number> {
    const installed = readInstalledPlugins();
    const fresh = findNewPlugins(installed, this.checked());
    if (fresh.length === 0) return 0;
    const results: { name: string; level: string }[] = [];
    for (const p of fresh) {
      try {
        const r = await checkPluginHeadless(cli, p.packageName);
        results.push({ name: p.packageName, level: r.level });
      } catch {
        results.push({ name: p.packageName, level: "fail" });
      }
    }
    // 记录：把当前全部非官方插件标记为已检测，避免下次重复打扰
    const known = new Set(this.checked());
    for (const p of installed) {
      if (!OFFICIAL_BUNDLES.has(p.packageName)) known.add(p.packageName);
    }
    await this.context.globalState.update(PluginWatch.KEY, [...known]);
    const lines = results.map((r) => `${compatLevelIcon(r.level as "ok" | "warning" | "inactive" | "fail")} ${r.name}`).join("\n");
    const pick = await vscode.window.showInformationMessage(
      t(
        `检测到 ${results.length} 个新插件（可能由聊天中的 agent 或外部安装），已自动完成兼容性检测：\n${lines}\n\n提示：✅=可加载 ⚠️=部分可能不生效 ⚪=仅安装未激活 ❌=检测失败。检测只保证「能加载」，不保证功能完全可用。`,
        `${results.length} new plugin(s) detected (possibly installed by the agent in chat or externally); compatibility was checked automatically:\n${lines}\n\nNote: ✅=loads ⚠️=some parts may not work ⚪=installed but inactive ❌=check failed. The check only covers loading, not full functionality.`
      ),
      t("查看插件中心", "Open Plugin Center")
    );
    if (pick === t("查看插件中心", "Open Plugin Center")) {
      // 打开插件中心：延迟到当前 await 之后由调用方打开，这里直接触发命令
      void vscode.commands.executeCommand("dsh-harness-vscode.pluginCenter");
    }
    return results.length;
  }
}
