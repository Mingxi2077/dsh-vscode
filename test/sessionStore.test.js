const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionStore, stableHash } = require("../out/sessionStore.js");

const createdRoots = [];

function tmpRoot() {
  // 临时目录放在工作区内，适配受限沙箱环境；由 after 统一清理
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-"));
  createdRoots.push(root);
  return root;
}

after(() => {
  for (const root of createdRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stableHash 稳定且区分输入", () => {
  assert.equal(stableHash("abc"), stableHash("abc"));
  assert.notEqual(stableHash("abc"), stableHash("abd"));
  assert.equal(typeof stableHash("任意目录"), "string");
});

test("会话保存、加载、列出与删除", () => {
  const store = new SessionStore(tmpRoot(), "C:\\proj");
  const session = {
    id: "sess-1",
    title: "标题",
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: "m1", role: "user", content: "hi", ts: 1 }],
  };
  store.save(session);

  const loaded = store.load("sess-1");
  assert.ok(loaded, "应能加载刚保存的会话");
  assert.equal(loaded.title, "标题");
  assert.equal(loaded.messages.length, 1);
  assert.ok(loaded.updatedAt >= 1, "保存时应刷新 updatedAt");

  const list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "sess-1");

  store.remove("sess-1");
  assert.equal(store.load("sess-1"), undefined);
  assert.equal(store.list().length, 0);
});

test("不同工作区目录的会话互不干扰", () => {
  const root = tmpRoot();
  const storeA = new SessionStore(root, "C:\\projA");
  const storeB = new SessionStore(root, "C:\\projB");
  storeA.save({ id: "s-a", title: "A", createdAt: 1, updatedAt: 1, messages: [] });
  assert.equal(storeB.load("s-a"), undefined);
  assert.equal(storeB.list().length, 0);
});

test("非法会话 id 被拒绝（防路径穿越）", () => {
  const store = new SessionStore(tmpRoot(), "C:\\proj");
  assert.throws(() => store.load("../../evil"));
  assert.throws(() => store.save({ id: "a/b", title: "t", createdAt: 1, updatedAt: 1, messages: [] }));
});

test("会话文件里的坏消息被丢弃，好会话仍可载入", () => {
  const root = tmpRoot();
  const store = new SessionStore(root, "C:\\proj");
  const dir = path.join(root, "sessions", stableHash("C:\\proj"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "mixed.json"),
    JSON.stringify({
      id: "mixed",
      title: "mixed",
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { id: "ok", role: "user", content: "hi", ts: 1 },
        { id: "bad-role", role: "evil", content: "x", ts: 2 },
        { id: "bad-content", role: "assistant", content: 42, ts: 3 },
      ],
    }),
    "utf8"
  );
  const loaded = store.load("mixed");
  assert.equal(loaded.messages.length, 1, "坏消息应被丢弃");
  assert.equal(loaded.messages[0].content, "hi");
});

test("损坏的会话文件返回 undefined 而非抛错", () => {
  const root = tmpRoot();
  const store = new SessionStore(root, "C:\\proj");
  const dir = path.join(root, "sessions", stableHash("C:\\proj"));
  fs.writeFileSync(path.join(dir, "bad.json"), "not json", "utf8");
  assert.equal(store.load("bad"), undefined);
  assert.equal(store.list().length, 0, "损坏文件不应出现在会话列表");
});
