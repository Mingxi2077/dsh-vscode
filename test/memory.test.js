const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectMemory } = require("../out/memory.js");

test("ProjectMemory：追加写入原子完成且保留历史（tmp+rename 不残留）", () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-memory-"));
  try {
    const memory = new ProjectMemory(root);
    memory.append("第一条记忆");
    memory.append("第二条记忆");
    const content = memory.read();
    assert.ok(content.includes("第一条记忆"), "应保留第一条");
    assert.ok(content.includes("第二条记忆"), "应包含第二条");
    const leftovers = fs.readdirSync(path.join(root, ".dsh")).filter((f) => f.endsWith(".tmp"));
    assert.equal(leftovers.length, 0, "原子写完成后不得残留 tmp 文件");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
