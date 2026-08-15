const test = require("node:test");
const assert = require("node:assert/strict");
const { extractCodeBlocks } = require("../out/codeBlocks.js");

test("extractCodeBlocks：pathHint 去掉模型常带的 :行号 后缀", () => {
  const md = "src\\utils.ts\n```ts\n// file: src/a.ts:12\nconsole.log(1)\n```\n";
  const blocks = extractCodeBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].pathHint, "src/a.ts", "路径提示不应包含行号");
  assert.ok(blocks[0].code.includes("console.log(1)"));
});

test("extractCodeBlocks：紧邻前一行路径提示生效", () => {
  const md = "src/b.ts\n```ts\nconst x = 1;\n```\n";
  const blocks = extractCodeBlocks(md);
  assert.equal(blocks[0].pathHint, "src/b.ts");
});

test("extractCodeBlocks：无路径提示时语言标记可兜底", () => {
  const blocks = extractCodeBlocks("```src/c.ts\ncode\n```\n");
  assert.equal(blocks[0].pathHint, "src/c.ts");
});
