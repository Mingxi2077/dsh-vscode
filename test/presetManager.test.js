const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  PRESETS,
  presetById,
  readPatch,
  listEnabledPresets,
  isPresetEnabled,
  enablePreset,
  disablePreset,
} = require("../out/presetManager.js");

function tmpPatch(content) {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-preset-"));
  const dir = path.join(root, "profiles", "headless");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cordis.patch.yml");
  if (content) fs.writeFileSync(file, content, "utf8");
  return { root, file };
}

test("PRESETS：预设定义完整且唯一", () => {
  assert.ok(PRESETS.length >= 2, "应至少 2 个预设");
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(p.id && p.name && p.description, "预设字段完整");
    assert.ok(p.targets.length > 0, "应有覆盖目标");
    assert.ok(!ids.has(p.id), `不应重复: ${p.id}`);
    ids.add(p.id);
  }
  assert.ok(presetById("auto-compact"), "auto-compact 存在");
  assert.ok(presetById("strict-plan"), "strict-plan 存在");
  assert.equal(presetById("nonexistent"), undefined);
});

test("readPatch：文件不存在时返回默认模板", () => {
  const { root, file } = tmpPatch(undefined);
  try {
    const raw = readPatch(file);
    assert.ok(raw.includes("dsh-vscode"), "默认模板含标记");
    assert.ok(raw.includes("[]"), "默认模板含空数组");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enablePreset：从空 patch 写入条目", () => {
  const { root, file } = tmpPatch(undefined);
  try {
    const res = enablePreset("auto-compact", file);
    assert.equal(res.ok, true);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("dsh-vscode-preset: auto-compact"), "应含预设标记");
    assert.ok(raw.includes("- id: compaction-basic"), "应含插件 id");
    assert.ok(raw.includes("auto: true"), "应含 auto 配置");
    assert.ok(raw.includes("thresholdRatio: 0.8"), "应含阈值配置");
    assert.ok(isPresetEnabled("auto-compact", file), "应识别为已启用");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enablePreset：幂等（重复启用不重复写）", () => {
  const { root, file } = tmpPatch(undefined);
  try {
    enablePreset("strict-plan", file);
    const r1 = enablePreset("strict-plan", file);
    assert.equal(r1.ok, true);
    const raw = fs.readFileSync(file, "utf8");
    assert.equal((raw.match(/dsh-vscode-preset: strict-plan/g) || []).length, 1, "标记只出现一次");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enablePreset：多预设共存 + 保留已有内容", () => {
  const { root, file } = tmpPatch("# 用户已有注释\n[]\n");
  try {
    enablePreset("auto-compact", file);
    enablePreset("strict-plan", file);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("用户已有注释"), "应保留原注释");
    assert.ok(raw.includes("dsh-vscode-preset: auto-compact"), "应含 auto-compact");
    assert.ok(raw.includes("dsh-vscode-preset: strict-plan"), "应含 strict-plan");
    assert.equal(listEnabledPresets(file).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disablePreset：移除对应条目且保留其他", () => {
  const { root, file } = tmpPatch(undefined);
  try {
    enablePreset("auto-compact", file);
    enablePreset("strict-plan", file);
    const res = disablePreset("auto-compact", file);
    assert.equal(res.ok, true);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("dsh-vscode-preset: auto-compact"), "auto-compact 标记应移除");
    assert.ok(!raw.includes("thresholdRatio"), "auto-compact 配置应移除");
    assert.ok(raw.includes("dsh-vscode-preset: strict-plan"), "strict-plan 应保留");
    assert.equal(listEnabledPresets(file).length, 1);
    // 再停用未启用的，幂等
    const r2 = disablePreset("auto-compact", file);
    assert.equal(r2.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("disablePreset：全部停用后无残留条目且保留空数组（DSH 可解析）", () => {
  const { root, file } = tmpPatch(undefined);
  try {
    enablePreset("auto-compact", file);
    disablePreset("auto-compact", file);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("dsh-vscode-preset:"), "不应残留预设标记");
    assert.ok(!raw.includes("- id:"), "不应残留插件条目");
    assert.ok(raw.includes("[]"), "必须保留空数组 []（DSH 要求顶层是 YAML 数组，纯注释会导致解析失败）");
    assert.equal(listEnabledPresets(file).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readPatch：损坏的纯注释文件被归一化为带空数组", () => {
  const { root, file } = tmpPatch("# 只有注释，没有数组\n");
  try {
    const raw = readPatch(file);
    assert.ok(raw.includes("[]"), "纯注释文件读后应补 []");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
