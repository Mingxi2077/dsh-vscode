const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionTracer } = require("../out/sessionTracer.js");

const SAMPLE_LINES = [
  '{"type":"session","version":0,"id":"session-test","createdAt":1,"cwd":"C:\\\\proj","delegationDepth":0}',
  '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}',
  '{"type":"tool/call","seq":1,"time":2,"data":{"turn":1,"step":1,"callId":"call_1","name":"pwsh","arguments":"{\\"command\\": \\"ls\\"}"}}',
  '{"type":"reasoning-chunks","seq":2,"time":3,"data":{"turn":1,"step":1,"index":0,"texts":["我","在","思考"]}}',
  '{"type":"text-chunks","seq":3,"time":4,"data":{"turn":1,"step":1,"index":0,"texts":["最终","回答"]}}',
  '{"type":"tool/result","seq":4,"time":5,"data":{"turn":1,"step":1,"callId":"call_1","message":{"content":[{"type":"tool-result","toolCallId":"call_1","content":[{"type":"text","text":"OK"}],"isError":false}],"role":"user"}}}',
  '{"type":"assistant/message","seq":5,"time":6,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":"思考内容"},{"type":"text","text":"回答内容"},{"type":"tool-call","id":"c2","name":"bash","arguments":"{}"}],"source":{"kind":"model"}}}}',
  '{"type":"turn/end","seq":6,"time":7,"data":{"turn":1,"reason":{"kind":"completed"}}}',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("SessionTracer：tail 会话日志并归一化为进度消息", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-tracer-"));
  try {
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions-vscode"); // 与 SessionTracer / patch 保持一致
    fs.mkdirSync(sessionsDir, { recursive: true });

    const tracer = new SessionTracer({ DSH_HOME: home }, Date.now());

    // 模拟本次任务产生的新会话目录
    const sessionDir = path.join(sessionsDir, "bucket", "session-test-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    const log = path.join(sessionDir, "session.jsonl");

    const messages = [];
    const signal = new AbortController().signal;
    const runPromise = tracer.start((m) => messages.push(m), signal);

    await sleep(400); // 等轮询发现文件
    fs.writeFileSync(log, SAMPLE_LINES.slice(0, 3).join("\n") + "\n");
    await sleep(350); // 模拟增量写入第一批
    fs.writeFileSync(log, SAMPLE_LINES.join("\n") + "\n");
    await sleep(350); // 第二批（完整）
    tracer.finish();
    await runPromise;

    assert.ok(messages.some((m) => m.kind === "turn" && m.turn === 1), "应收到 turn 事件");
    assert.ok(messages.some((m) => m.kind === "tool" && m.name === "pwsh"), "应收到 tool/call");
    assert.ok(messages.some((m) => m.kind === "reasoning" && m.text.includes("思考")), "应收到 reasoning 块");
    assert.ok(messages.some((m) => m.kind === "text"), "应收到 text 块");
    assert.ok(
      messages.some((m) => m.kind === "tool-result" && !m.isError && m.summary === "OK"),
      "应收到 tool-result 摘要"
    );
    assert.ok(messages.some((m) => m.kind === "assistant"), "应收到 assistant 快照");
    assert.ok(
      messages.some((m) => m.kind === "done" && m.reason === "completed"),
      "应收到 turn/end"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionTracer：找不到新会话文件时静默结束（不抛错）", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-tracer-"));
  try {
    const tracer = new SessionTracer({ DSH_HOME: path.join(root, "nohome") }, Date.now());
    const messages = [];
    const controller = new AbortController();
    // 30 秒找不到会超时；这里用已中止信号直接验证安全退出
    controller.abort();
    await tracer.start((m) => messages.push(m), controller.signal);
    assert.equal(messages.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
