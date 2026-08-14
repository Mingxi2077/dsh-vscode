# DSH Agent for VS Code

在 VS Code 里像使用 Claude Code 一样使用 [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness)：一个聊天面板，DSH agent 直接在你的项目目录中工作（读写文件、执行命令、给出方案），会话自动保存在本机。

> 实现原理：每条消息通过子进程调用 `dsh --profile headless "<任务>"`，以当前工作区目录作为 agent 的工作目录。无需常驻服务，不依赖 dsh web 的内部 API。

---

## 快速开始（普通用户，无需源码、无需编译）

1. **获取插件**：下载 `dsh-harness-vscode-<版本>.vsix` 文件（一个文件，随发布提供）。
2. **安装**：VS Code 扩展面板（`Ctrl+Shift+X`）→ 右上角 `⋯` → **从 VSIX 安装…** → 选择下载的 `.vsix`。
   - 或用命令行：`code --install-extension dsh-harness-vscode-0.7.0.vsix`
3. **配置 API Key**：`Ctrl+Shift+P` → **DSH: 配置 API Key** → 输入你的 DeepSeek API Key（`sk-...`，在 [platform.deepseek.com](https://platform.deepseek.com) 申请）。
   - Key 保存在**系统密钥链**（VS Code SecretStorage），不写入任何配置文件。
4. **打开一个项目文件夹**（工作区）。
5. **运行「DSH: 检查环境」**，确认 dsh 与 API Key 都就绪。
6. **运行「DSH: 打开对话」**，或点击左下角状态栏的 `DSH` 按钮，开始使用。

> 没在 VS Code 里配 Key 也可以：设置系统环境变量 `DEEPSEEK_API_KEY`，或把 Key 放进 `~/.dsh/.credentials.yaml`（与 `dsh web` 共用）。三选一即可。

## 前置要求

- 已全局安装 DSH 命令行：`npm i -g @deepseek-ai/dsh`（安装后新开终端执行 `dsh --version` 应能输出版本号）。
- 一个 DeepSeek API Key（见上方第 3 步）。
- VS Code ≥ 1.86，Node ≥ 22（扩展会自动以 `--expose-internals` 启动 dsh 并优先使用 PATH 上的 node；推荐 Node ≥ 24）。

如果 `dsh` 不在 PATH 中，可在扩展设置 `dsh-harness-vscode.cliPath` 中手动指定路径。

## 使用

- 在聊天面板输入任务，`Enter` 发送。DSH 会在你的项目目录中自主工作（读文件、改代码、跑命令），**运行过程中实时展示思考过程与工具调用**（可折叠的"思考过程"、工具卡片、回答草稿，思考按「第 N 轮 · 第 M 步」细分），完成后给出正式答复。
- **目标（goals）流式呈现**：DSH 使用 goal 工具创建/更新/完成目标时，会以目标卡片实时展示（🎯 创建 / ✏️ 更新 / ⏸ 暂停 / ▶️ 恢复 / ✅ 完成 / 🚧 受阻），并保留到最终思维链轨迹中。
- **会话自动命名**：任务完成后会话标题由 DSH 自动生成（不再是首条消息截断）。
- **活动栏侧边栏**：活动栏 DSH 图标 → 侧边栏「状态」显示当前模型/思维强度/沙箱/记忆，并有打开对话、检查环境、兼容性自检、查看/编辑记忆等快捷入口。
- **内置 Chat 集成**：在 VS Code 内置 Chat（Copilot Chat）里 `@dsh-agent <任务>` 直接唤起，可用 `#文件` 引用作为上下文，答复流式吐回聊天流。
- **📎 选中代码 / 📄 当前文件**：把编辑器里的选中内容或当前文件挂到输入区上方作为上下文（可随时移除）。
- **🕘 历史会话 / ＋ 新建会话**：会话按工作区目录持久化到本机，可随时切换。
- **回答中的文件引用可点击**：`src/main.ts:12` 这类路径会自动变成链接，点击即在编辑器打开并定位到行。
- 助手回答右上角 **复制 / 插入代码 / 应用到文件**：插入代码把第一段代码块插入当前编辑器光标处；应用到文件则把代码块写入项目文件（自动猜路径、写入前确认、不越出工作区）。
- 任务运行中可点 **取消** 终止（底层会杀掉子进程）。
- 右键资源管理器中的文件 → **DSH: 询问此文件**，快速让 DSH 分析该文件。

### 聊天内 slash 命令

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令帮助 |
| `/clear` | 新建会话 |
| `/provider` | 切换模型提供商，可输入/更新该提供商的 API Key（存系统密钥链） |
| `/model` | 按当前提供商切换模型 |
| `/effort` | 切换思维强度（off/low/medium/high/max；非推理模型请用 off） |
| `/skills` | 列出并选择要启用的技能（`~/.dsh/skills` 或 `<项目>/.dsh/skills`，每技能一个目录含 SKILL.md） |
| `/compact` | 把当前会话压缩成摘要并替换历史，释放上下文 |
| `/status` | 查看当前提供商/模型/思维强度/技能/用量 |
| `/memory` | 查看项目长期记忆 |
| `/edit-memory` | 在编辑器中打开记忆文件 |
| `/remember <内容>` | 把一条知识记入项目长期记忆（如常用命令、架构约定） |
| `/context` | 查看当前挂载的上下文 |

**用量状态条**：输入区上方会显示「模型 · 思维强度 · 输入/输出 token · 缓存命中率 · 推理 token」，随任务实时更新（数据来自 DSH 会话日志的 usage 字段）。

### 命令面板快捷操作

- **DSH: 解释当前文件**：把当前文件挂为上下文并请求解释。
- **DSH: 审查当前改动 (git diff)**：自动抓取 `git diff` 作为上下文并请求审查。
- **DSH: 为当前文件写测试**：挂当前文件并请求编写单元测试。
- **DSH: 打开 dsh 终端**：在集成终端运行 `dsh web`（独立端口 3088）。
- **DSH: 查看 / 编辑项目记忆**：查看或编辑工作区 `.dsh/memory.md`（DSH 每次任务会自动参考其中的内容）。

### 长期记忆

项目长期记忆保存在工作区根目录的 `.dsh/memory.md`，每次任务自动注入任务文本。适合记录：构建/测试命令、架构约定、踩坑记录、决策依据。可用 `/remember` 快速追加，或用 `/edit-memory` 直接编辑（已随仓库版本化，可提交）。

## 配置项（设置 → 搜索 `dsh`）

| 键 | 默认 | 说明 |
|---|---|---|
| `dsh-harness-vscode.cliPath` | `""` | dsh 可执行文件或 `lib/bin.js` 的绝对路径；留空自动从 PATH 解析（Windows 下会直接定位 JS 入口以规避 cmd 转义问题） |
| `dsh-harness-vscode.extraArgs` | `[]` | 附加到启动命令的参数（如 `--patch <path>`） |
| `dsh-harness-vscode.timeoutSeconds` | `600` | 单次任务超时秒数，超时自动取消 |
| `dsh-harness-vscode.environment` | `{}` | 传给 dsh 子进程的额外环境变量（如 API Key） |
| `dsh-harness-vscode.historyMessages` | `20` | 拼进任务文本的最近消息条数（用于延续多轮对话） |
| `dsh-harness-vscode.maxMessageChars` | `8000` | 单条历史/上下文内容拼入任务文本的最大字符数 |
| `dsh-harness-vscode.streamProgress` | `true` | 实时展示思维链与工具调用过程（通过 tail DSH 会话事件日志）；关闭后仅显示最终答复 |

## 常见问题

**「未找到 dsh 命令」/ 检查环境失败**
→ 说明 dsh 未安装或不在 PATH。执行 `npm i -g @deepseek-ai/dsh`，然后**新开一个终端**验证 `dsh --version`；或在设置里用 `dsh-harness-vscode.cliPath` 指定完整路径。

**检查环境显示「API Key 未配置」**
→ 执行 **DSH: 配置 API Key** 输入你的 DeepSeek API Key（sk-...）；或在系统环境变量里设置 `DEEPSEEK_API_KEY`。DSH 内置默认提供商 `deepseek-official`，有 Key 即可用，无需其它配置。

**发送消息后提示 MISSING_CREDENTIAL**
→ 同上：未检测到 API Key。面板会直接给出指引。

**任务提示超时**
→ 调大 `dsh-harness-vscode.timeoutSeconds`（默认 600 秒）。

**任务文本里的特殊字符被破坏（Windows）**
→ 本扩展默认会自动定位 `dsh` 的 JS 入口并用 node 直接启动，规避 cmd 转义。如果仍异常，请反馈。

## 开发者：从源码构建

```bash
git clone <本仓库> dsh-harness-vscode
cd dsh-harness-vscode
npm install
npm run compile      # 或 npm run watch 增量编译
npm test             # 运行单元测试
npx vsce package     # 打包出 .vsix
```

- F5 调试运行：`.vscode/launch.json` 已配置好（需要先 `npm install`）。
- 源码结构：`src/`（扩展主体：cli 运行器、聊天面板、会话存储）、`media/`（Webview 前端）、`test/`（单元测试）。

## 安全说明

扩展本身不直接执行任何文件/命令操作——它把任务交给 `dsh --profile headless`，DSH 自带沙箱与审批栈：

- **沙箱**：默认 `workspace-write`，agent 只能读写当前工作区内的文件，shell 在受限模式（Windows 下 PowerShell ConstrainedLanguage）运行。已实测：尝试写工作区外的文件会被拒绝。
- **审批**：默认 `ask`；但 headless 无交互应答器，因此**需要审批的越权操作一律失败关闭（自动拒绝）**——agent 无法自我放行危险操作。
- **可配置**：设置 `dsh-harness-vscode.permissionMode` 可切 `read-only` / `workspace-write` / `danger-full-access`。⚠ `danger-full-access` 会完全解除限制且审批自动放行，仅在完全信任任务时使用。

使用建议：在委托 agent 改动项目前，先 `git status` 确认工作区干净（或已提交），这样任何误操作都可通过版本控制回退。

## 说明与限制

- 每次消息都是一次全新的 `headless` 会话：多轮上下文由扩展把最近消息拼进任务文本实现，历史不会无限增长。
- 流式进度通过 tail DSH 的会话事件日志（明文 JSONL）实现：展示思考、工具调用与回答草稿；最终答复仍以 headless 的 stdout 为准。若日志不可用（如旧版 dsh 不支持 `compression: none`），自动降级为仅显示最终答复。
- 会话数据保存在 VS Code 扩展的 `globalStorage` 下（按工作区目录分桶），卸载扩展后仍在；项目记忆保存在工作区 `.dsh/memory.md`。

## License

MIT
