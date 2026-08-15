const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildSpawnArgs, capTaskText, resolveCli } = require("../out/cli.js");

test("entry 模式：--expose-internals + 入口 + launcher 参数 + 任务文本（不含 node 自身）", () => {
  const args = buildSpawnArgs(
    { kind: "entry", node: "C:/node.exe", entry: "C:/x/bin.js", source: "test" },
    ["--patch", "p.yml"],
    "任务 文本"
  );
  assert.deepEqual(args, [
    "--expose-internals",
    "C:/x/bin.js",
    "--profile",
    "headless",
    "--patch",
    "p.yml",
    "任务 文本",
  ]);
  // 可执行文件由调用方单独传入，绝不能出现在参数里（否则 node 会把 exe 当脚本跑）
  assert.ok(!args.includes("C:/node.exe"));
});

test("command 模式：直接命令 + 任务文本", () => {
  const args = buildSpawnArgs(
    { kind: "command", command: "dsh", source: "test" },
    [],
    "task"
  );
  assert.deepEqual(args, ["--profile", "headless", "task"]);
});

test("extraArgs 为空时不产生额外参数（entry 模式仍带 expose-internals）", () => {
  const args = buildSpawnArgs(
    { kind: "entry", node: "node", entry: "e.js", source: "test" },
    [],
    "hi"
  );
  assert.deepEqual(args, ["--expose-internals", "e.js", "--profile", "headless", "hi"]);
});

test("capTaskText：win32 超长任务文本被截断并标记（防 Windows 命令行 32k 限制）", () => {
  const long = "x".repeat(30000);
  const capped = capTaskText(long, 100, "win32");
  assert.ok(capped.length < long.length, "超长文本应被截断");
  assert.ok(capped.length <= 100 + 100, "截断后不应远超上限（仅加截断标记）");
  assert.match(capped, /截断|truncated/, "应含截断标记");
  // 非 Windows 不截断
  assert.equal(capTaskText(long, 100, "linux"), long);
  // 未超限不截断
  assert.equal(capTaskText("hello", 100, "win32"), "hello");
});

test("resolveCli：配置 .cmd shim 时解析同目录 lib/bin.js（避免 spawn EINVAL）", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-cli-"));
  try {
    const shim = path.join(root, "dsh.cmd");
    const entry = path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// fake dsh entry\n", "utf8");
    fs.writeFileSync(shim, "@echo off\n", "utf8");
    const cli = await resolveCli(shim);
    assert.equal(cli.kind, "entry", "应解析为 entry 模式而不是直接 spawn .cmd");
    assert.equal(cli.entry, entry);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
