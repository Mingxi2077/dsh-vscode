const test = require("node:test");
const assert = require("node:assert/strict");
const { extractCodeBlocks } = require("../out/codeBlocks.js");

test("extractCodeBlocks 提取围栏代码块并猜测路径", () => {
  const md = [
    "下面是修改建议：",
    "",
    "修改 `src/main.ts`：",
    "```ts",
    "console.log('hi')",
    "```",
    "",
    "再改这个文件：",
    "```python",
    "# file: src/util.py",
    "print(1)",
    "```",
  ].join("\n");

  const blocks = extractCodeBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].language, "ts");
  assert.equal(blocks[0].pathHint, "src/main.ts");
  assert.equal(blocks[0].code, "console.log('hi')");
  assert.equal(blocks[1].language, "python");
  assert.equal(blocks[1].pathHint, "src/util.py");
});

test("extractCodeBlocks 无路径提示时返回空 hint", () => {
  const md = ["```js", "const a = 1;", "```"].join("\n");
  const blocks = extractCodeBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].pathHint, undefined);
  assert.equal(blocks[0].code, "const a = 1;");
});

test("extractCodeBlocks 无围栏时返回空数组", () => {
  assert.deepEqual(extractCodeBlocks("没有代码块，只是文本"), []);
});
