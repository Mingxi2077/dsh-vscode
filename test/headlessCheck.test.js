const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseDumpConfig, checkPluginHeadless } = require("../out/headlessCheck.js");

test("parseDumpConfig：bundle 插件已加载 → ok", () => {
  const dump = [
    "# == @deepseek-ai/dsh-base",
    "- id: web-search-firecrawl",
    "  name: '@yangzhe1003/dsh-web-search-firecrawl'",
    "# == @yangzhe1003/dsh-web-search-firecrawl",
    "- id: web-search-firecrawl",
    "  name: '@yangzhe1003/dsh-web-search-firecrawl'",
    "    apiKey: !!js process.env.FIRECRAWL_API_KEY",
    "# == @deepseek-ai/dsh-base, patched by @yangzhe1003/dsh-web-search-firecrawl",
    "    searchProvider: firecrawl",
  ].join("\n");
  const r = parseDumpConfig(dump, "@yangzhe1003/dsh-web-search-firecrawl");
  assert.equal(r.level, "ok");
  assert.equal(r.hasPatchBlock, true, "应有 patch 来源块");
  assert.ok(r.matchedEntries.length > 0, "应有匹配的插件行");
  assert.equal(r.missingEntries.length, 0);
});

test("parseDumpConfig：entry not found 警告 → warning", () => {
  const dump = [
    'dsh: [dsh-vscode-local-demo] patch: entry "dsh-vscode-local-demo" not found',
    "# == dsh-vscode-local-demo",
    "- id: dsh-vscode-local-demo",
    "  name: dsh-vscode-local-demo",
  ].join("\n");
  const r = parseDumpConfig(dump, "dsh-vscode-local-demo");
  assert.equal(r.level, "warning");
  assert.equal(r.hasPatchBlock, true);
  assert.ok(r.missingEntries.length > 0, "应识别 entry not found 警告");
});

test("parseDumpConfig：非 bundle → inactive", () => {
  const dump = "# == @deepseek-ai/dsh-base\n- id: agent\n  name: '@deepseek-ai/dsh-agent'\n";
  const r = parseDumpConfig(dump, "@dsh-external/dsh-artifact");
  assert.equal(r.level, "inactive");
  assert.equal(r.hasPatchBlock, false);
});

test("checkPluginHeadless：真实运行 dump-config 并解析为 ok", async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-check-"));
  try {
    const script = path.join(dir, "fake-dsh.js");
    fs.writeFileSync(
      script,
      'process.stdout.write("# == fake-pkg\\n");\nprocess.stdout.write("- id: fake\\n  name: fake-pkg\\n");\n',
      "utf8"
    );
    const cli = { kind: "entry", node: process.execPath, entry: script, source: "test" };
    const r = await checkPluginHeadless(cli, "fake-pkg");
    assert.equal(r.ran, true);
    assert.equal(r.level, "ok");
    assert.equal(r.hasPatchBlock, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPluginHeadless：非零退出 → fail", async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-check-"));
  try {
    const script = path.join(dir, "fail-dsh.js");
    fs.writeFileSync(script, "process.exit(3);\n", "utf8");
    const cli = { kind: "entry", node: process.execPath, entry: script, source: "test" };
    const r = await checkPluginHeadless(cli, "fake-pkg");
    assert.equal(r.ran, false);
    assert.equal(r.level, "fail");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
