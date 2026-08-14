# DSH Agent for VS Code — 0.9.1 测试方案

> 目标版本：0.9.1（本地已安装，需重载窗口生效）
> 前置：dsh 已装（v0.1.0-rc.6）、DEEPSEEK_API_KEY 已配置、打开一个项目文件夹

## 0. 部署确认（重载前）

1. 关闭所有 VS Code 窗口 → 重新打开（或 `Ctrl+Shift+P` → `Developer: Reload Window`）。
2. 活动栏出现 DSH 鲸鱼图标。
3. 侧边栏「状态」视图显示 `扩展：v0.9.1`。
4. `Ctrl+Shift+P` → `DSH: 检查环境`，输出面板应显示：
   - `dsh 定位`、`版本`、`API Key: 已配置`、`沙箱模式: workspace-write`
   - **Provider 配置检查**段、**headless 插件**段（🟢/⚪ 状态）、**模式预设**段
5. `Ctrl+Shift+P` → `DSH: 兼容性自检`，约 10-20 秒后应提示**自检通过**。

## 0a. 国际化专项（0.9.x）

| # | 步骤 | 预期 |
|---|------|------|
| 0a.1 | 把 VS Code 界面语言切到 English（`Ctrl+Shift+P` → Configure Display Language → en → 重载） | 命令面板全是英文（DSH: Open Chat / Plugin Center / Mode Presets…）；侧边栏全英文（Model / Effort / Sandbox / Memory…）；聊天面板按钮/占位符英文 |
| 0a.2 | 英文界面下发一条消息 | 注入给 DSH 的任务模板是英文，agent 用英文回复 |
| 0a.3 | 切回中文界面重载 | 全部恢复中文 |
| 0a.4 | 打开市场页 https://marketplace.visualstudio.com/items?itemName=mingxi2077.dsh-harness-vscode | 英文用户看到 "Everything is a plugin. Watch a plugin-driven AI agent..." 开头；中文用户看到"一切皆插件。" |

## 0b. 插件系统专项（0.9.x）

| # | 步骤 | 预期 |
|---|------|------|
| 0b.1 | `Ctrl+Shift+P` → `DSH: 插件中心` | 列出「📦 已安装插件」（🟢 @deepseek-ai/dsh-base、🟢 dsh-headless、⚪ dsh-plugin-doctor 未激活）+「✨ 精选可装插件」 |
| 0b.2 | 选中某个已装插件 → 详情 | 显示描述、状态（激活/未激活） |
| 0b.3 | 插件中心 → 刷新 | 列表重新读取，无报错 |
| 0b.4 | `Ctrl+Shift+P` → `DSH: 模式预设` | 显示 2 个预设（自动会话压缩 / 严格计划模式），都未启用 |
| 0b.5 | 启用「自动会话压缩」→ 查看 `~/.dsh/profiles/headless/cordis.patch.yml` | 文件含 `dsh-vscode-preset: auto-compact` + `- id: compaction-basic` + `auto: true` |
| 0b.6 | 再启用「严格计划模式」→ 发一个实现类任务（如"修改某文件加一行注释"） | agent 先出完整计划，调用 exit_plan_mode，**不直接改文件**（计划模式生效） |
| 0b.7 | 停用「自动会话压缩」→ 查看 cordis.patch.yml | auto-compact 条目移除，**strict-plan 条目保留** |
| 0b.8 | 停用「严格计划模式」→ 查看 cordis.patch.yml | **必须恢复为 `[]` 空数组**（纯注释会导致 DSH 无法启动——0.9.1 修复点） |
| 0b.9 | 停用全部预设后，`dsh --dump-config` 或「DSH: 检查环境」 | **正常**（无 "must be a top-level YAML array" 报错） |

## 0c. 预设与截图回归（之前已测）

- 市场页截图（3 张）仍显示：https://marketplace.visualstudio.com/items?itemName=mingxi2077.dsh-harness-vscode
- README 英文主版 + 中文版（README.zh.md）都有，开头是"一切皆插件 / Everything is a plugin"

## 1. 基础对话（回归）

| # | 步骤 | 预期 |
|---|------|------|
| 1.1 | 打开对话面板，输入 `请介绍一下当前项目结构` | 状态栏「DSH 运行中」；实时思考/工具调用；最终 markdown 答复 |
| 1.2 | 回答上方「思维链与工具调用（N 项）」折叠块 | 可展开，每步思考与工具卡 |
| 1.3 | 发多步任务 | 头部显示「第 N 轮 · 第 M 步」 |
| 1.4 | 发 goal 提示词 | 🎯 目标卡 → ✅ 完成 |
| 1.5 | 发多步骤任务 | 任务清单 ⬜→🔄→✅ |
| 1.6 | 完成后看面板标题 | DSH 自动命名 |

## 2. Provider 回归

| # | 步骤 | 预期 |
|---|------|------|
| 2.1 | 聊天 `/provider` | 分组列表：官方内置 / 已配置 / 手动添加 |
| 2.2 | 选内置（如 Anthropic）→ 确认写入 → 输 Key | settings.yaml 出现 `anthropic:`（仅 apiKeyEnv，无 models） |
| 2.3 | `/model` | 列出该 provider 精选模型 |
| 2.4 | `/provider` → 手动添加自定义 | 向导可用，写入配置 + 备份文件 |
| 2.5 | `DSH: 检查环境` | Provider 段列出已配置 provider |

## 3. 核心功能回归

| # | 功能 | 预期 |
|---|------|------|
| 3.1 | `/remember` 记忆 → 新会话任务 | 新任务自动参考记忆 |
| 3.2 | 选中代码 → 📎 加入上下文 | 上下文块出现，可移除 |
| 3.3 | 文件引用点击（`src/xx.ts:12`） | 编辑器打开定位 |
| 3.4 | 代码块「应用到文件」 | 确认 → 写入（不越出工作区） |
| 3.5 | 取消任务 | 状态复位可再发 |
| 3.6 | 历史会话 / 新建会话 | 正常切换 |
| 3.7 | @dsh-agent 参与者 | 内置 Chat 里可用 |
| 3.8 | 沙箱：让 DSH 写工作区外文件 | 被拒 |

## 4. 自动化测试（可选）

```powershell
cd E:\my_project\testAPI\DEEPSEEK\harness\dsh-vscode
npm test          # 45 个单元测试
node test\e2e.test.js   # E2E（需 API Key）
```

## 5. 结果记录

| 测试项 | 结果（通过/失败） | 备注 |
|--------|------------------|------|
| 0.x 部署确认 | | |
| 0a i18n | | |
| 0b 插件系统 | | |
| 1.x 基础对话 | | |
| 2.x Provider | | |
| 3.x 回归 | | |

> 发现失败项请记录：哪一步、实际表现、期望表现。
