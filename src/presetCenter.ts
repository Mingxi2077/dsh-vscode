import * as vscode from "vscode";
import {
  PRESETS,
  PresetDef,
  listEnabledPresets,
  enablePreset,
  disablePreset,
} from "./presetManager";

/** 模式预设中心：启用/停用 DSH 原生行为预设（写入 headless cordis.patch.yml）。 */
export async function openPresetCenter(): Promise<void> {
  const enabled = listEnabledPresets();
  const pick = await vscode.window.showQuickPick(
    [
      { label: "🧩 DSH 模式预设", kind: vscode.QuickPickItemKind.Separator },
      ...PRESETS.map((p) => ({
        label: `${enabled.includes(p.id) ? "✅" : "⬜"} ${p.name}`,
        description: enabled.includes(p.id) ? "已启用" : "未启用",
        detail: p.description,
        presetId: p.id,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(info) 说明", description: "预设写入 headless profile 的 cordis.patch.yml，重载窗口后生效", presetId: "__help__" },
    ],
    { placeHolder: "选择要启用/停用的预设（点已启用的可停用）", matchOnDetail: true }
  );
  if (!pick || !pick.presetId) return;
  const rawId = pick.presetId as string;

  if (rawId === "__help__") {
    void vscode.window.showInformationMessage(
      "DSH 模式预设通过修改 headless profile 的 cordis.patch.yml 覆盖 DSH 原生插件配置（last write wins）。\n" +
        "· 启用后下次任务即生效（无需重启 DSH，需重载扩展窗口让 UI 刷新）\n" +
        "· 停用会移除对应配置行，恢复 DSH 默认行为\n" +
        "· 配置文件：~/.dsh/profiles/headless/cordis.patch.yml",
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
      `停用预设「${preset.name}」？将移除 cordis.patch.yml 中的对应配置，恢复 DSH 默认行为。`,
      { modal: true },
      "停用"
    );
    if (confirm !== "停用") return;
    const res = disablePreset(preset.id);
    if (res.ok) {
      void vscode.window.showInformationMessage(`${res.message}（下次任务生效）`);
    } else {
      void vscode.window.showErrorMessage(res.message);
    }
  } else {
    const confirm = await vscode.window.showWarningMessage(
      `启用预设「${preset.name}」？将写入 ~/.dsh/profiles/headless/cordis.patch.yml 覆盖对应配置。`,
      { modal: true },
      "启用"
    );
    if (confirm !== "启用") return;
    const res = enablePreset(preset.id);
    if (res.ok) {
      void vscode.window.showInformationMessage(`${res.message}（下次任务生效）`);
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
