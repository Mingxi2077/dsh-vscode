const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  resolveExistingInsideRoot,
  resolveForCreateInsideRoot,
} = require("../out/pathSafety.js");

test("pathSafety：工作区内已有文件放行，区外拒绝", () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-path-"));
  try {
    const inside = path.join(root, "a.txt");
    fs.writeFileSync(inside, "x", "utf8");
    assert.equal(resolveExistingInsideRoot(root, inside).ok, true);
    assert.equal(resolveExistingInsideRoot(root, path.join(root, "..", "outside.txt")).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pathSafety：待创建路径从其最近已存在祖先验证边界", () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-path-"));
  try {
    const res = resolveForCreateInsideRoot(root, path.join(root, "new", "dir", "file.ts"));
    assert.equal(res.ok, true);
    assert.ok(res.realPath, "应返回真实路径");
    const outside = resolveForCreateInsideRoot(root, path.join(root, "..", "new", "file.ts"));
    assert.equal(outside.ok, false, "待创建目标逃逸到区外必须拒绝");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pathSafety：区外符号链接逃逸被拒绝", async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-path-"));
  const outside = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-path-out-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    const link = path.join(root, "link");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch (err) {
      t.skip(`当前环境无法创建目录链接（${err.code || err.message}），跳过 symlink 用例`);
      return;
    }
    const res = resolveExistingInsideRoot(root, path.join(link, "secret.txt"));
    assert.equal(res.ok, false, "通过区外符号链接访问文件必须拒绝");
    const create = resolveForCreateInsideRoot(root, path.join(link, "new.txt"));
    assert.equal(create.ok, false, "通过区外符号链接创建文件必须拒绝");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
