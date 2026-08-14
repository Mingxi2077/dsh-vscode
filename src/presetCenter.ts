import * as vscode from "vscode";
import {
  PRESETS,
  PresetDef,
  listEnabledPresets,
  enablePreset,
  disablePreset,
} from "./presetManager";
import { t } from "./i18n";

/** 模式预设中心：启用/停用 DSH 原生行为预设（写入 headless cordis.patch.yml）。 */
export async function openPresetCenter(): Promise<void> {
  const enabled = listEnabledPresets();
  const pick = await vscode.window.showQuickPick(
    [
      { label: "🧩 " + t("DSH 模式预设", "DSH Mode Presets"), kind: vscode.QuickPickItemKind.Separator },
      ...PRESETS.map((p) => ({
        label: `${enabled.includes(p.id) ? "✅" : "⬜"} ${t(p.name, p.enName ?? p.name)}`,
        description: enabled.includes(p.id) ? t("已启用", "enabled") : t("未启用", "disabled"),
        detail: t(p.description, p.enDescription ?? p.description),
        presetId: p.id,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(info) " + t("说明", "Help"), description: t("预设写入 headless profile 的 cordis.patch.yml，下次任务生效", "Presets are written to the headless profile's cordis.patch.yml; effective on next task"), presetId: "__help__" },
    ],
    { placeHolder: t("选择要启用/停用的预设（点已启用的可停用）", "Choose a preset to enable/disable (click an enabled one to disable)"), matchOnDetail: true }
  );
  if (!pick || !pick.presetId) return;
  const rawId = pick.presetId as string;

  if (rawId === "__help__") {
    void vscode.window.showInformationMessage(
      t(
        "DSH 模式预设通过修改 headless profile 的 cordis.patch.yml 覆盖 DSH 原生插件配置（last write wins）。\n· 启用后下次任务即生效\n· 停用会移除对应配置行，恢复 DSH 默认行为\n· 配置文件：~/.dsh/profiles/headless/cordis.patch.yml",
        "DSH mode presets override DSH native plugin config in the headless profile's cordis.patch.yml (last write wins).\n· Enabled → effective on next task\n· Disabled → removes the config lines, restoring DSH defaults\n· Config file: ~/.dsh/profiles/headless/cordis.patch.yml"
      ),
      { modal: true }
    );
    return;
  }

  const preset = PRESETS.find((p) => p.id === rawId);
  if (!preset) return;
  await togglePreset(preset, enabled.includes(preset.id));
}

async function togglePreset(preset: PresetDef, currentlyEnabled: boolean): Promise<void> {
  if (currentlyEnabled) {
    const confirm = await vscode.window.showWarningMessage(
      t(
        `停用预设「${preset.name}」？将移除 cordis.patch.yml 中的对应配置，恢复 DSH 默认行为。`,
        `Disable preset "${preset.enName ?? preset.name}"? This removes its config lines from cordis.patch.yml and restores DSH defaults.`
      ),
      { modal: true },
      t("停用", "Disable")
    );
    if (confirm !== t("停用", "Disable")) return;
    const res = disablePreset(preset.id);
    if (res.ok) {
      const name = t(res.presetName ?? preset.name, res.enPresetName ?? preset.name);
      const msg =
        res.message === "disabled"
          ? t(`已停用预设「${name}」`, `Preset "${name}" disabled`)
          : t(`预设「${name}」未启用`, `Preset "${name}" is not enabled`);
      void vscode.window.showInformationMessage(`${msg}（${t("下次任务生效", "effective next task")}）`);
    } else {
      void vscode.window.showErrorMessage(res.message);
    }
  } else {
    const confirm = await vscode.window.showWarningMessage(
      t(
        `启用预设「${preset.name}」？将写入 ~/.dsh/profiles/headless/cordis.patch.yml 覆盖对应配置。`,
        `Enable preset "${preset.enName ?? preset.name}"? This writes to ~/.dsh/profiles/headless/cordis.patch.yml, overriding the corresponding config.`
      ),
      { modal: true },
      t("启用", "Enable")
    );
    if (confirm !== t("启用", "Enable")) return;
    const res = enablePreset(preset.id);
    if (res.ok) {
      const name = t(res.presetName ?? preset.name, res.enPresetName ?? preset.name);
      const msg =
        res.message === "enabled"
          ? t(`已启用预设「${name}」`, `Preset "${name}" enabled`)
          : t(`预设「${name}」已启用`, `Preset "${name}" is already enabled`);
      void vscode.window.showInformationMessage(`${msg}（${t("下次任务生效", "effective next task")}）`);
    } else {
      void vscode.window.showErrorMessage(res.message);
    }
  }
}

/** 供"检查环境"输出预设状态。 */
export function presetStatusSummary(): string[] {
  const enabled = listEnabledPresets();
  if (enabled.length === 0) return ["未启用任何模式预设（DSH 默认行为）"];
  return enabled.map((id) => {
    const p = PRESETS.find((x) => x.id === id);
    return `✅ ${p?.name ?? id}（${id}）`;
  });
}
