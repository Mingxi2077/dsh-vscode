const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  upsertProvider,
  hasProvider,
  catalogProfile,
  writeProviderToSettings,
} = require("../out/settingsEditor.js");

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-settings-"));
  const file = path.join(dir, "settings.yaml");
  if (content) fs.writeFileSync(file, content, "utf8");
  return file;
}

test("upsertProvider：空文件追加 llm-pi-ai 段", () => {
  const next = upsertProvider("", { id: "openai", apiKeyEnv: "OPENAI_API_KEY", displayName: "OpenAI" });
  assert.ok(next.includes("llm-pi-ai:"), "应创建 llm-pi-ai 段");
  assert.ok(next.includes("  providers:"), "应创建 providers");
  assert.ok(next.includes("    openai:"), "应有 openai 条目");
  assert.ok(next.includes("      apiKeyEnv: OPENAI_API_KEY"), "应有 apiKeyEnv");
  assert.ok(next.includes("      displayName: OpenAI"), "应有 displayName");
});

test("upsertProvider：已有 llm-pi-ai 但无 providers 时插入", () => {
  const raw = "ui-onboarding:\n  welcomeNoticeVersion: 1\nllm-pi-ai:\n  something-else: true\nagent-default-model:\n  provider: x\n";
  const next = upsertProvider(raw, { id: "lmuai", apiKeyEnv: "LMUAI_API_KEY" });
  assert.ok(next.includes("  providers:"), "应插入 providers");
  assert.ok(next.includes("    lmuai:"), "应有 lmuai 条目");
  assert.ok(next.includes("agent-default-model:"), "不应破坏后续段");
  // providers 必须位于 llm-pi-ai 块内（agent-default-model 之前）
  const piIdx = next.indexOf("llm-pi-ai:");
  const provIdx = next.indexOf("  providers:");
  const admIdx = next.indexOf("agent-default-model:");
  assert.ok(piIdx < provIdx && provIdx < admIdx, "providers 应插在 llm-pi-ai 块内、后续段之前");
});

test("upsertProvider：追加到已有 providers（保留既有条目）", () => {
  const raw = "llm-pi-ai:\n  providers:\n    lmuai:\n      displayName: LMU\n      apiKeyEnv: LMUAI_API_KEY\nagent-default-model:\n  provider: x\n";
  const next = upsertProvider(raw, { id: "openai", apiKeyEnv: "OPENAI_API_KEY" });
  assert.ok(next.includes("    lmuai:"), "应保留既有 provider");
  assert.ok(next.includes("    openai:"), "应追加新 provider");
  assert.ok(next.includes("      apiKeyEnv: OPENAI_API_KEY"), "新条目含 apiKeyEnv");
});

test("upsertProvider：替换已有同名 provider（缩进正确，4 空格）", () => {
  const raw = "llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: OLD_KEY\n      models:\n        - id: old\n";
  const next = upsertProvider(raw, { id: "openai", apiKeyEnv: "OPENAI_API_KEY", displayName: "OpenAI" });
  assert.ok(!next.includes("OLD_KEY"), "旧 apiKeyEnv 应被替换");
  assert.ok(!next.includes("old"), "旧 models 应被移除");
  // 精确验证缩进：provider 必须位于 4 空格，字段 6 空格（8/10 空格是无效 YAML）
  assert.ok(next.includes("    openai:"), "provider 应为 4 空格缩进");
  assert.ok(next.includes("      apiKeyEnv: OPENAI_API_KEY"), "apiKeyEnv 应为 6 空格缩进");
  assert.ok(next.includes("      displayName: OpenAI"), "displayName 应为 6 空格缩进");
  assert.ok(!next.includes("        openai:"), "不应出现 8 空格缩进（双重缩进 bug）");
  // 后续结构未被破坏
  assert.ok(next.includes("  providers:"), "providers 仍在");
});

test("hasProvider：识别 llm-pi-ai.providers 内的条目", () => {
  const raw = "llm-pi-ai:\n  providers:\n    lmuai:\n      apiKeyEnv: X\n    openai:\n      apiKeyEnv: Y\n";
  assert.equal(hasProvider(raw, "lmuai"), true);
  assert.equal(hasProvider(raw, "openai"), true);
  assert.equal(hasProvider(raw, "anthropic"), false);
});

test("catalogProfile：只写 apiKeyEnv + displayName，不写 models（DSH 目录提供）", () => {
  const p = catalogProfile("openai", "OPENAI_API_KEY", "OpenAI");
  assert.deepEqual(p, { id: "openai", apiKeyEnv: "OPENAI_API_KEY", displayName: "OpenAI" });
  assert.equal(p.models, undefined, "catalog profile 不应带 models");
});

test("writeProviderToSettings：真实文件写入 + 备份 + 幂等", () => {
  const raw = "llm-pi-ai:\n  providers:\n    lmuai:\n      apiKeyEnv: LMUAI_API_KEY\n";
  const file = tmpFile(raw);
  try {
    const r1 = writeProviderToSettings({ id: "openai", apiKeyEnv: "OPENAI_API_KEY" }, file);
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, true);
    const content = fs.readFileSync(file, "utf8");
    assert.ok(content.includes("    openai:"), "应写入 openai");
    assert.ok(content.includes("    lmuai:"), "应保留 lmuai");
    // 幂等：再次写入同 provider 不重复
    const r2 = writeProviderToSettings({ id: "openai", apiKeyEnv: "OPENAI_API_KEY" }, file);
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false, "已存在不应重复写");
    const after = fs.readFileSync(file, "utf8");
    assert.equal((after.match(/openai:/g) || []).length, 1, "openai 只出现一次");
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("writeProviderToSettings：文件不存在时创建", () => {
  const file = tmpFile(undefined);
  try {
    const r = writeProviderToSettings({ id: "openai", apiKeyEnv: "OPENAI_API_KEY" }, file);
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    const content = fs.readFileSync(file, "utf8");
    assert.ok(content.includes("llm-pi-ai:"));
    assert.ok(content.includes("    openai:"));
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("upsertProvider：无 llm-pi-ai 段时保留原文件其它配置（防数据丢失回归）", () => {
  const raw = "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\nui-onboarding:\n  welcomeNoticeVersion: 1\n";
  const next = upsertProvider(raw, { id: "lmuai", apiKeyEnv: "LMUAI_API_KEY" });
  assert.ok(next.includes("agent-default-model:"), "应保留 agent-default-model 段");
  assert.ok(next.includes("ui-onboarding:"), "应保留 ui-onboarding 段");
  assert.ok(next.includes("  provider: deepseek-official"), "应保留原内容正文");
  assert.ok(next.includes("llm-pi-ai:"), "应追加 llm-pi-ai 段");
  assert.ok(next.includes("    lmuai:"), "应有新 provider");
});

test("upsertProvider：替换 providers 段内最后一个 provider（其后有顶层键）不产生重复", () => {
  const raw = "llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: OLD_KEY\nagent-default-model:\n  provider: x\n";
  const next = upsertProvider(raw, { id: "openai", apiKeyEnv: "NEW_KEY" });
  assert.ok(!next.includes("OLD_KEY"), "旧 apiKeyEnv 应被替换");
  assert.equal((next.match(/openai:/g) || []).length, 1, "openai 只应出现一次（不得重复条目）");
  assert.ok(next.includes("      apiKeyEnv: NEW_KEY"), "应为新值");
  assert.ok(next.includes("agent-default-model:"), "不应破坏后续段");
});
