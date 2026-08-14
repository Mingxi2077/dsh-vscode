// E2E 集成测试：真实 dsh headless 跑一次 tiny 任务，验证流式补丁（明文会话日志）生效。
// 依赖真实环境：dsh 已安装 + DEEPSEEK_API_KEY 可用。环境不满足时自动跳过（不失败）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCli, buildSpawnArgs, runDsh } = require("../out/cli.js");

function apiKeyValue() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const cred = path.join(os.homedir(), ".dsh", ".credentials.yaml");
  try {
    const m = fs.readFileSync(cred, "utf8").match(/DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)/);
    if (m) return m[1].trim();
  } catch {
    // 忽略
  }
  return undefined;
}

function hasApiKey() {
  return !!apiKeyValue();
}

function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

test("E2E：headless tiny 任务生成明文会话日志（流式补丁生效）", { timeout: 180000 }, async (t) => {
  let cli;
  try {
    cli = await resolveCli();
  } catch (err) {
    t.skip(`dsh 不可用：${err.message}`);
    return;
  }
  if (!hasApiKey()) {
    t.skip("未检测到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml），跳过 E2E");
    return;
  }

  // 用隔离的 DSH_HOME，避免污染真实会话日志；DSH_HOME 改变后凭据读不到，
  // 所以把 DEEPSEEK_API_KEY 显式注入环境（有就用，没有则 DSH 从凭据服务兜底）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-e2e-"));
  try {
    const env = { ...process.env, DSH_HOME: home };
    const key = apiKeyValue();
    if (key && !env.DEEPSEEK_API_KEY) env.DEEPSEEK_API_KEY = key;
    const patch = path.join(__dirname, "..", "patch", "stream.patch.yml");
    const args = buildSpawnArgs(cli, ["--patch", patch], "请只回复两个字：好的");
    const result = await runDsh(cli, args, {
      cwd: path.join(__dirname, ".."),
      timeoutMs: 150000,
      env,
    });

    assert.equal(result.code, 0, `任务应成功退出，stderr: ${result.stderr.slice(0, 300)}`);
    assert.match(result.stdout, /好的/, "应输出预期文本");

    // 流式补丁：sessions-vscode 下应生成明文 session.jsonl
    const sessionsDir = path.join(home, "sessions-vscode");
    const logs = walkFiles(sessionsDir).filter((f) => f.endsWith("session.jsonl"));
    assert.ok(logs.length > 0, "应生成明文会话日志（流式补丁生效）");
    const raw = fs.readFileSync(logs[0], "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "日志非空");
    const types = new Set();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type) types.add(rec.type);
      } catch {
        // 忽略个别损坏行
      }
    }
    assert.ok(types.has("session"), "日志应含 session 头记录");
    assert.ok(
      types.has("turn/start") || types.has("assistant/message") || types.has("reasoning-chunks"),
      `日志应含事件记录，实际类型: ${[...types].join(", ")}`
    );
    // 明文 JSONL：不应是 zstd 二进制（文件本身可被 JSON 解析已间接证明）
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
