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

test("SessionTracer：step/start-end、session/title、assistant/chunk block-end 归一化", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-tracer-"));
  try {
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions-vscode");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const tracer = new SessionTracer({ DSH_HOME: home }, Date.now());
    const sessionDir = path.join(sessionsDir, "bucket", "session-test-2");
    fs.mkdirSync(sessionDir, { recursive: true });
    const log = path.join(sessionDir, "session.jsonl");

    const lines = [
      '{"type":"session","version":0,"id":"s2","createdAt":1,"cwd":"C:\\\\p","delegationDepth":0}',
      '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}',
      '{"type":"step/start","seq":1,"time":2,"data":{"turn":1,"step":1}}',
      // fallback 标题应被跳过
      '{"type":"session/title","seq":2,"time":3,"data":{"title":"你在 VS Code 中通过 DSH","source":{"kind":"fallback"}}}',
      // LLM 生成的标题应被接受
      '{"type":"session/title","seq":3,"time":4,"data":{"title":"查看TEXT文件内容","source":{"kind":"model"}}}',
      '{"type":"reasoning-chunks","seq":4,"time":5,"data":{"turn":1,"step":1,"index":0,"texts":["增量","碎片"]}}',
      // block-end 权威块（reasoning + tool-call）
      '{"type":"assistant/chunk","seq":5,"time":6,"data":{"turn":1,"step":1,"chunk":{"type":"block-end","index":0,"block":{"type":"reasoning","text":"完整思考内容"}}}}',
      '{"type":"assistant/chunk","seq":6,"time":7,"data":{"turn":1,"step":1,"chunk":{"type":"block-end","index":1,"block":{"type":"tool-call","id":"call_x","name":"read","arguments":"{\\"file\\":\\"a.txt\\"}"}}}}',
      '{"type":"step/end","seq":7,"time":8,"data":{"turn":1,"step":1}}',
      '{"type":"turn/end","seq":8,"time":9,"data":{"turn":1,"reason":{"kind":"completed"}}}',
    ];

    const messages = [];
    const signal = new AbortController().signal;
    const runPromise = tracer.start((m) => messages.push(m), signal);
    await sleep(400);
    fs.writeFileSync(log, lines.join("\n") + "\n");
    await sleep(350);
    tracer.finish();
    await runPromise;

    assert.ok(messages.some((m) => m.kind === "step" && m.active === true && m.step === 1), "应收到 step/start");
    assert.ok(messages.some((m) => m.kind === "step" && m.active === false && m.step === 1), "应收到 step/end");
    const titles = messages.filter((m) => m.kind === "title");
    assert.equal(titles.length, 1, "fallback 标题应被跳过，只收 LLM 标题");
    assert.equal(titles[0].title, "查看TEXT文件内容");
    const reasoningBlock = messages.find((m) => m.kind === "block" && m.blockType === "reasoning");
    assert.ok(reasoningBlock, "应收到 reasoning block-end");
    assert.equal(reasoningBlock.text, "完整思考内容");
    assert.equal(reasoningBlock.key, "1:1:0");
    const toolBlock = messages.find((m) => m.kind === "block" && m.blockType === "tool-call");
    assert.ok(toolBlock, "应收到 tool-call block-end");
    assert.equal(toolBlock.callId, "call_x");
    assert.ok(toolBlock.args.includes("a.txt"), "tool-call block-end 应带参数");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionTracer：goal/change 归一化为目标进度消息", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-tracer-"));
  try {
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions-vscode");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const tracer = new SessionTracer({ DSH_HOME: home }, Date.now());
    const sessionDir = path.join(sessionsDir, "bucket", "session-test-3");
    fs.mkdirSync(sessionDir, { recursive: true });
    const log = path.join(sessionDir, "session.jsonl");

    const lines = [
      '{"type":"session","version":0,"id":"s3","createdAt":1,"cwd":"C:\\\\p","delegationDepth":0}',
      '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}',
      '{"type":"goal/change","seq":1,"time":2,"data":{"kind":"goal/change","version":1,"operation":"create","goal":{"id":"goal-abc","revision":1,"objective":"测试目标","phase":"active","maxGoalRounds":256},"roundsStarted":0,"createdAt":2,"updatedAt":2}}',
      '{"type":"goal/change","seq":2,"time":3,"data":{"kind":"goal/change","version":1,"operation":"complete","goal":{"id":"goal-abc","revision":2,"objective":"测试目标","phase":"complete","maxGoalRounds":256},"roundsStarted":1,"createdAt":2,"updatedAt":3}}',
      '{"type":"turn/end","seq":3,"time":4,"data":{"turn":1,"reason":{"kind":"completed"}}}',
    ];

    const messages = [];
    const signal = new AbortController().signal;
    const runPromise = tracer.start((m) => messages.push(m), signal);
    await sleep(400);
    fs.writeFileSync(log, lines.join("\n") + "\n");
    await sleep(350);
    tracer.finish();
    await runPromise;

    const goals = messages.filter((m) => m.kind === "goal");
    assert.equal(goals.length, 2, "应收到两条 goal/change");
    assert.equal(goals[0].operation, "create");
    assert.equal(goals[0].id, "goal-abc");
    assert.equal(goals[0].objective, "测试目标");
    assert.equal(goals[0].phase, "active");
    assert.equal(goals[1].operation, "complete");
    assert.equal(goals[1].phase, "complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionTracer：todo/write 归一化为任务清单快照", async () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-tracer-"));
  try {
    const home = path.join(root, "home");
    const sessionsDir = path.join(home, "sessions-vscode");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const tracer = new SessionTracer({ DSH_HOME: home }, Date.now());
    const sessionDir = path.join(sessionsDir, "bucket", "session-test-4");
    fs.mkdirSync(sessionDir, { recursive: true });
    const log = path.join(sessionDir, "session.jsonl");

    const lines = [
      '{"type":"session","version":0,"id":"s4","createdAt":1,"cwd":"C:\\\\p","delegationDepth":0}',
      '{"type":"turn/start","seq":0,"time":1,"data":{"turn":1}}',
      '{"type":"todo/write","seq":1,"time":2,"data":{"todos":[{"content":"扫描依赖","status":"in_progress"},{"content":"汇总报告","status":"pending"}]}}',
      '{"type":"todo/write","seq":2,"time":3,"data":{"todos":[{"content":"扫描依赖","status":"completed"},{"content":"汇总报告","status":"completed"}]}}',
      '{"type":"turn/end","seq":3,"time":4,"data":{"turn":1,"reason":{"kind":"completed"}}}',
    ];

    const messages = [];
    const signal = new AbortController().signal;
    const runPromise = tracer.start((m) => messages.push(m), signal);
    await sleep(400);
    fs.writeFileSync(log, lines.join("\n") + "\n");
    await sleep(350);
    tracer.finish();
    await runPromise;

    const todos = messages.filter((m) => m.kind === "todo");
    assert.equal(todos.length, 2, "应收到两条 todo/write");
    assert.equal(todos[0].todos.length, 2);
    assert.equal(todos[0].todos[0].content, "扫描依赖");
    assert.equal(todos[0].todos[0].status, "in_progress");
    assert.equal(todos[1].todos[1].status, "completed", "第二条快照应显示全部完成");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
