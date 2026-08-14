const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSpawnArgs } = require("../out/cli.js");

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
