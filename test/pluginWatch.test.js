const test = require("node:test");
const assert = require("node:assert/strict");
const { findNewPlugins, OFFICIAL_BUNDLES } = require("../out/pluginManager.js");

test("findNewPlugins：识别未检测过的新插件，排除官方 bundles", () => {
  const installed = [
    { packageName: "@deepseek-ai/dsh-base", active: true },
    { packageName: "@deepseek-ai/dsh-headless", active: true },
    { packageName: "@yangzhe1003/dsh-web-search-firecrawl", active: true },
    { packageName: "dsh-plugin-doctor", active: false },
  ];
  const fresh = findNewPlugins(installed, ["@yangzhe1003/dsh-web-search-firecrawl"]);
  assert.deepEqual(
    fresh.map((p) => p.packageName),
    ["dsh-plugin-doctor"],
    "只应返回未检测的非官方插件"
  );
});

test("findNewPlugins：全部已检测或只有官方时返回空", () => {
  const installed = [
    { packageName: "@deepseek-ai/dsh-base", active: true },
    { packageName: "dsh-plugin-doctor", active: false },
  ];
  assert.deepEqual(findNewPlugins(installed, ["dsh-plugin-doctor"]), [], "全部已检测应返回空");
  assert.deepEqual(findNewPlugins([{ packageName: "@deepseek-ai/dsh-base", active: true }], []), [], "仅官方 bundle 应返回空");
});

test("OFFICIAL_BUNDLES：包含两个官方核心 bundle", () => {
  assert.ok(OFFICIAL_BUNDLES.has("@deepseek-ai/dsh-base"));
  assert.ok(OFFICIAL_BUNDLES.has("@deepseek-ai/dsh-headless"));
});
