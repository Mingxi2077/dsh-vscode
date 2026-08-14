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
  extractBuiltAllowNames,
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

test("extractBuiltAllowNames：从真实 pnpm 错误提取包名", () => {
  const { extractBuiltAllowNames } = require("../out/pluginManager.js");
  // 真实 build 许可错误（stdout）
  const buildErr = `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED Failed to prepare git-hosted package fetched from "https://codeload.github.com/omdsh-dev/dsh-toolkit/tar.gz/x": The git-hosted package "@deepseek-ai/dsh-toolkit@0.0.1" needs to execute build scripts but is not in the "onlyBuiltDependencies" allowlist.`;
  const names = extractBuiltAllowNames(buildErr);
  assert.ok(names.includes("@deepseek-ai/dsh-toolkit"), "应提取 scoped 包名");
  // 无 build 错误时返回空（避免误判）
  assert.deepEqual(extractBuiltAllowNames("dsh: git-hosted plugins build on install via their prepare script"), []);
});

test("analyzePluginError：识别 npm 404（npmmirror CDN 路径）并提取依赖名", () => {
  const { analyzePluginError } = require("../out/pluginManager.js");
  const out = [
    "npm error code ETARGET",
    "npm error 404 Not Found - GET https://cdn.npmmirror.com/packages/%40deepseek-ai/dsh-type-meta/0.0.1-rc.1",
    "npm error 404",
    "npm error  A complete log of this run can be found in: ...",
  ].join("\n");
  const a = analyzePluginError(out, "");
  assert.equal(a.kind, "dep404");
  assert.equal(a.missingDep, "@deepseek-ai/dsh-type-meta");
  assert.ok(a.lines.some((l) => l.includes("404 Not Found")), "应保留真实 404 行");
  assert.ok(a.lines.every((l) => l.length <= 200), "行应限长");
});

test("analyzePluginError：识别 npm 404（官方 registry %2f 形式）", () => {
  const { analyzePluginError } = require("../out/pluginManager.js");
  const a = analyzePluginError("", "npm error 404 Not Found - GET https://registry.npmjs.org/@deepseek-ai%2fdsh-type-meta - Not found");
  assert.equal(a.kind, "dep404");
  assert.equal(a.missingDep, "@deepseek-ai/dsh-type-meta");
});

test("analyzePluginError：识别网络错误（超时/不可达）", () => {
  const { analyzePluginError } = require("../out/pluginManager.js");
  const a = analyzePluginError(
    "",
    "pnpm error ERR_PNPM_FETCH_503 request to https://registry.npmjs.org/... failed, reason: connect ETIMEDOUT 104.16.24.34:443"
  );
  assert.equal(a.kind, "network");
  assert.ok(a.lines.some((l) => l.includes("ETIMEDOUT")), "应保留网络错误行");
});

test("analyzePluginError：过滤 DSH 误导提示行，保留真实错误", () => {
  const { analyzePluginError } = require("../out/pluginManager.js");
  const out = [
    "dsh: git-hosted plugins build on install via their prepare script",
    "dsh: add the exact key pnpm printed above",
    "pnpm error ERR_PNPM_META_FETCH_FAILED GET https://registry.npmjs.org/dsh-toolkit: ...",
    "npm error 404 Not Found - GET https://cdn.npmmirror.com/packages/dsh-toolkit/0.1.0",
  ].join("\n");
  const a = analyzePluginError(out, "");
  assert.equal(a.kind, "dep404", "应优先判定为 404");
  assert.equal(a.missingDep, "dsh-toolkit");
  assert.ok(!a.lines.some((l) => l.includes("git-hosted plugins build on install")), "应过滤误导行");
  assert.ok(!a.lines.some((l) => l.includes("add the exact key pnpm printed")), "应过滤提示行");
  assert.ok(a.lines.some((l) => l.includes("404")), "应保留真实 404 行");
});

test("analyzePluginError：generic 提取错误行（非 404 / 非网络）", () => {
  const { analyzePluginError } = require("../out/pluginManager.js");
  const a = analyzePluginError("", "pnpm error ERR_PNPM_LOCKFILE_INCOMPLETE broken lockfile at pnpm-lock.yaml");
  assert.equal(a.kind, "generic");
  assert.ok(a.lines.some((l) => l.includes("ERR_PNPM")), "应保留错误行");
});

test("analyzePluginError：generic 不把 Progress 进度行当错误", () => {
  const { analyzePluginError } = require("../out/pluginManager.js");
  const a = analyzePluginError("", "Progress: resolved 1, reused 0, downloaded 0, added 0\npnpm error ERR_PNPM_FETCH_404 x");
  assert.equal(a.kind, "dep404");
  assert.ok(!a.lines.some((l) => l.startsWith("Progress:")), "应跳过进度行");
});

test("runPluginCommand：双流输出后正常退出应判定成功（close 时序回归）", async () => {
  const { runPluginCommand } = require("../out/pluginManager.js");
  const dir = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-plugin-"));
  try {
    const script = path.join(dir, "ok.js");
    fs.writeFileSync(
      script,
      'process.stdout.write("dsh: installed test-pkg\\n");\nprocess.stderr.write("WARN peer stuff\\n");\n',
      "utf8"
    );
    const cli = { kind: "entry", node: process.execPath, entry: script, source: "test" };
    const res = await runPluginCommand(cli, "add", "test-pkg");
    assert.equal(res.ok, true, `应判定成功，实际: ${res.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPluginCommand：非零退出 + 404 输出 → dep404 分类", async () => {
  const { runPluginCommand } = require("../out/pluginManager.js");
  const dir = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-plugin-"));
  try {
    const script = path.join(dir, "fail404.js");
    fs.writeFileSync(
      script,
      'process.stderr.write("npm error 404 Not Found - GET https://cdn.npmmirror.com/packages/dep/1.0.0\\n");\nprocess.exit(1);\n',
      "utf8"
    );
    const cli = { kind: "entry", node: process.execPath, entry: script, source: "test" };
    const res = await runPluginCommand(cli, "add", "test-pkg");
    assert.equal(res.ok, false);
    assert.equal(res.kind, "dep404");
    assert.equal(res.missingDep, "dep");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
