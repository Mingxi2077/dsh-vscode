const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  readCustomProviders,
  listModels,
  apiKeyEnvFor,
  readDefaultEffort,
  writeModelPatch,
  CATALOG_PROVIDERS,
  catalogProviderById,
  isCatalogProvider,
} = require("../out/modelSelection.js");
const { buildTaskText } = require("../out/taskText.js");

function tmpSettings(content) {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-mdl-"));
  const file = path.join(root, "settings.yaml");
  fs.writeFileSync(file, content, "utf8");
  return { root, file };
}

const SAMPLE = `# dsh settings
ui-onboarding: done
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
  reasoningEffort: high
llm-pi-ai:
  providers:
    lmuai:
      displayName: "LMU AI"
      apiKeyEnv: LMUAI_API_KEY
      api:
        baseURL: https://api.lmu.ai/v1
      models:
        - name: lmu-chat
        - name: lmu-reason
    other:
      displayName: Other
      models:
        - name: other-1
`;

test("readCustomProviders 解析 settings.yaml 提供商", () => {
  const { root, file } = tmpSettings(SAMPLE);
  try {
    const providers = readCustomProviders(file);
    assert.equal(providers.length, 2);
    assert.equal(providers[0].id, "lmuai");
    assert.equal(providers[0].displayName, "LMU AI");
    assert.equal(providers[0].apiKeyEnv, "LMUAI_API_KEY");
    assert.equal(providers[1].id, "other");
    assert.equal(providers[1].apiKeyEnv, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listModels 按提供商返回模型", () => {
  const { root, file } = tmpSettings(SAMPLE);
  try {
    assert.deepEqual(listModels("lmuai", file), ["lmu-chat", "lmu-reason"]);
    assert.deepEqual(listModels("other", file), ["other-1"]);
    // 内置 deepseek 提供商固定清单
    assert.ok(listModels("deepseek-official").includes("deepseek-chat"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apiKeyEnvFor 与 readDefaultEffort", () => {
  const { root, file } = tmpSettings(SAMPLE);
  try {
    assert.equal(apiKeyEnvFor("lmuai", file), "LMUAI_API_KEY");
    assert.equal(apiKeyEnvFor("deepseek-official"), "DEEPSEEK_API_KEY");
    assert.equal(readDefaultEffort(file), "high");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeModelPatch 生成 settings 覆盖 + 指向它的补丁", () => {
  const root = fs.mkdtempSync(path.join(__dirname, "..", ".test-tmp-mdl-"));
  try {
    const settings = path.join(root, "src-settings.yaml");
    fs.writeFileSync(settings, SAMPLE, "utf8");
    const file = writeModelPatch(root, "hash", {
      provider: "lmuai",
      model: "lmu-chat",
      reasoningEffort: "max",
    }, settings);
    assert.ok(file && fs.existsSync(file), "补丁文件应生成");
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.includes("- id: settings"), "应补丁 settings-file");
    assert.ok(raw.includes("path:"), "应指向覆盖文件");
    // 覆盖文件内容
    const settingsFile = raw.match(/path:\s*(\S+)/)?.[1];
    assert.ok(settingsFile && fs.existsSync(settingsFile), "覆盖文件应存在");
    const over = fs.readFileSync(settingsFile, "utf8");
    assert.ok(over.includes("provider: lmuai"));
    assert.ok(over.includes("model: lmu-chat"));
    assert.ok(over.includes("reasoningEffort: max"));
    assert.ok(over.includes("llm-pi-ai:"), "应保留自配提供商块");
    assert.ok(over.includes("LMUAI_API_KEY"), "应保留 apiKeyEnv");
    // 无选择时返回 undefined
    assert.equal(writeModelPatch(root, "hash", { provider: "", model: "" }, settings), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildTaskText 包含会话配置与技能段", () => {
  const session = {
    id: "s1",
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    messages: [
      { id: "m1", role: "user", content: "你好", ts: 1 },
      { id: "m2", role: "assistant", content: "你好！", ts: 2 },
      { id: "m3", role: "user", content: "继续", ts: 3 },
    ],
  };
  const text = buildTaskText(
    "C:\\proj",
    session,
    [{ kind: "file", label: "README.md", content: "# demo" }],
    { excerpt: () => "记忆：构建用 npm run build" },
    20,
    8000,
    ["本会话模型配置：提供商 deepseek-official，模型 deepseek-v4-flash，思维强度 high", "本会话已启用技能：code-review"]
  );
  assert.ok(text.includes("本会话模型配置"));
  assert.ok(text.includes("code-review"));
  assert.ok(text.includes("项目长期记忆"));
  assert.ok(text.includes("README.md"));
  assert.ok(text.includes("--- 最新用户消息 ---"));
  assert.ok(text.includes("继续"));
});

test("CATALOG_PROVIDERS：内置清单含常见 provider 且字段完整", () => {
  assert.ok(CATALOG_PROVIDERS.length >= 10, "应内置至少 10 个 provider");
  for (const p of CATALOG_PROVIDERS) {
    assert.ok(p.id && p.id.length > 0, "应有 id");
    assert.ok(p.displayName, "应有 displayName");
    assert.equal(p.catalog, true, "内置 provider 应标记 catalog");
    if (p.apiKeyEnv) assert.match(p.apiKeyEnv, /^[A-Z_]+$/, `apiKeyEnv 应是大写下划线: ${p.apiKeyEnv}`);
  }
  // 常见 provider 存在
  for (const id of ["openai", "anthropic", "google", "openrouter", "mistral", "groq"]) {
    assert.ok(catalogProviderById(id), `应包含 ${id}`);
    assert.equal(isCatalogProvider(id), true);
  }
  // openai 应有代表模型
  const openai = catalogProviderById("openai");
  assert.ok(openai.models && openai.models.length > 0, "openai 应有模型清单");
  assert.equal(openai.apiKeyEnv, "OPENAI_API_KEY");
});

test("listModels：catalog provider 返回精选清单；apiKeyEnvFor 映射正确", () => {
  const models = listModels("openai");
  assert.ok(models.includes("gpt-5.2"), "openai 精选清单含 gpt-5.2");
  assert.ok(models.includes("gpt-4o"), "openai 精选清单含 gpt-4o");
  assert.equal(apiKeyEnvFor("openai"), "OPENAI_API_KEY");
  assert.equal(apiKeyEnvFor("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(apiKeyEnvFor("openrouter"), "OPENROUTER_API_KEY");
  // deepseek-official 仍是内置固定清单
  assert.deepEqual(listModels("deepseek-official"), ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"]);
});
