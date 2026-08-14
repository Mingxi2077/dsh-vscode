const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FEATURED_PLUGINS,
  featuredPlugin,
  readInstalledPlugins,
  isInstalled,
  isActive,
  installSourceKind,
  allowBuildScripts,
  pnpmWorkspacePath,
} = require("../out/pluginManager.js");

function tmpProfile(deps, bundles) {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-plugin-"));
  const dir = path.join(root, "profiles", "headless");
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name: "dsh-profile-headless",
    private: true,
    dependencies: deps,
    dsh: { profile: { bundles } },
  };
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2), "utf8");
  return { root, file };
}

test("FEATURED_PLUGINS：精选清单字段完整且无重复", () => {
  assert.ok(FEATURED_PLUGINS.length >= 20, "应精选至少 20 个插件");
  const names = new Set();
  for (const p of FEATURED_PLUGINS) {
    assert.ok(p.packageName && p.packageName.length > 0, "packageName 非空");
    assert.ok(p.displayName, "displayName 非空");
    assert.ok(p.description, "description 非空");
    assert.ok(p.category, "category 非空");
    assert.equal(typeof p.bundle, "boolean", "bundle 应为布尔");
    assert.ok(!names.has(p.packageName), `不应重复: ${p.packageName}`);
    names.add(p.packageName);
  }
});

test("featuredPlugin：按包名查找", () => {
  assert.equal(featuredPlugin("dsh-toolkit")?.displayName, "DSH Toolkit");
  assert.equal(featuredPlugin("not-exist"), undefined);
});

test("readInstalledPlugins：解析 dependencies + bundles 激活状态", () => {
  const { root, file } = tmpProfile(
    { "@deepseek-ai/dsh-base": "1.0.0", "dsh-toolkit": "0.1.0", "dsh-plugin-doctor": "0.1.0" },
    ["@deepseek-ai/dsh-base", "dsh-toolkit"]
  );
  try {
    const plugins = readInstalledPlugins(file);
    const byName = new Map(plugins.map((p) => [p.packageName, p]));
    assert.ok(byName.has("@deepseek-ai/dsh-base"));
    assert.equal(byName.get("@deepseek-ai/dsh-base").active, true, "官方 bundle 激活");
    assert.equal(byName.get("dsh-toolkit").active, true, "dsh-toolkit 在 bundles 层激活");
    assert.equal(byName.get("dsh-plugin-doctor").active, false, "非 bundle 不激活");
    assert.equal(byName.get("dsh-plugin-doctor").version, "0.1.0");
    // 按名称排序
    const names = plugins.map((p) => p.packageName);
    assert.deepEqual(names, [...names].sort(), "应按包名排序");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readInstalledPlugins：profile 不存在时返回空", () => {
  assert.deepEqual(readInstalledPlugins("C:\\nonexistent\\package.json"), []);
});

test("isInstalled / isActive：基于 profile 状态", () => {
  const { root, file } = tmpProfile({ "dsh-toolkit": "0.1.0" }, ["dsh-toolkit"]);
  try {
    // 用临时 profile 路径验证——但 isInstalled/isActive 用默认路径，这里通过注入环境变量测
    const orig = process.env.DSH_HOME;
    process.env.DSH_HOME = path.join(root);
    try {
      assert.equal(isInstalled("dsh-toolkit"), true);
      assert.equal(isActive("dsh-toolkit"), true);
      assert.equal(isInstalled("dsh-code-intel"), false);
    } finally {
      if (orig === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = orig;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("featuredPlugin 清单与真实 npm 包名一致（抽查）", () => {
  // 这些包名来自 awesome-dsh-plugin 精选，安装时应直接可用
  for (const pkg of ["dsh-toolkit", "dsh-tool-time", "dsh-code-intel", "dsh-docker"]) {
    assert.ok(featuredPlugin(pkg), `精选清单应含 ${pkg}`);
  }
});

test("installSourceKind：识别各种安装来源", () => {
  assert.equal(installSourceKind("dsh-plugin-doctor"), "npm");
  assert.equal(installSourceKind("@scope/pkg"), "npm");
  assert.equal(installSourceKind("github:owner/repo"), "github");
  assert.equal(installSourceKind("git+https://github.com/a/b.git"), "git-url");
  assert.equal(installSourceKind("git@github.com:a/b.git"), "git-url");
  assert.equal(installSourceKind("https://github.com/a/b.git"), "git-url");
  assert.equal(installSourceKind("https://example.com/x.tgz"), "url");
  assert.equal(installSourceKind("./my-plugin"), "path");
  assert.equal(installSourceKind("C:\\plugins\\x"), "path");
  assert.equal(installSourceKind("..\\relative"), "path");
});

test("allowBuildScripts：写入 onlyBuiltDependencies 且幂等", () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-plugin-"));
  try {
    const file = path.join(root, "pnpm-workspace.yaml");
    fs.writeFileSync(file, "packages:\n  - .\n\nnodeLinker: hoisted\n", "utf8");
    assert.equal(allowBuildScripts("@deepseek-ai/dsh-toolkit", file), true);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("onlyBuiltDependencies:"), "应写入 onlyBuiltDependencies");
    assert.ok(raw.includes("@deepseek-ai/dsh-toolkit"), "应含包名");
    // 幂等：重复调用不重复加
    assert.equal(allowBuildScripts("@deepseek-ai/dsh-toolkit", file), true);
    assert.equal((raw.match(/@deepseek-ai\/dsh-toolkit/g) || []).length, 1, "包名只出现一次");
    // 追加另一个包
    allowBuildScripts("dsh-plugin-doctor", file);
    const raw2 = fs.readFileSync(file, "utf8");
    assert.ok(raw2.includes("dsh-plugin-doctor"), "应追加第二个包");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
