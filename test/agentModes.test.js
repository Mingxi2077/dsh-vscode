const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_MODES,
  agentModeById,
  resolveAgentModePatch,
} = require("../out/agentModes.js");

test("AGENT_MODES：标准 / PTC / 极简 / 创造 定义完整且唯一", () => {
  assert.deepEqual(AGENT_MODES.map((m) => m.id), ["standard", "code", "minimal", "cordis"]);
  for (const m of AGENT_MODES) {
    assert.ok(m.name && m.nameEn && m.description && m.descriptionEn, `${m.id} 双语信息完整`);
  }
  assert.equal(agentModeById("code").name, "PTC 模式");
  assert.equal(agentModeById("nope"), undefined);
});

test("resolveAgentModePatch：从 dsh 入口解析内置预设文件", () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-mode-"));
  try {
    const entry = path.join(root, "lib", "bin.js");
    const preset = path.join(root, "config", "agent-presets", "minimal", "agent.cordis.yml");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.mkdirSync(path.dirname(preset), { recursive: true });
    fs.writeFileSync(entry, "// bin\n", "utf8");
    fs.writeFileSync(preset, "# minimal\n", "utf8");

    const res = resolveAgentModePatch({ kind: "entry", node: "node", entry, source: "test" }, "minimal");
    assert.equal(res.patch, preset);
    assert.equal(res.error, undefined);

    const missing = resolveAgentModePatch({ kind: "entry", node: "node", entry, source: "test" }, "cordis");
    assert.equal(missing.patch, undefined);
    assert.ok(missing.error, "缺失预设应有错误说明");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
