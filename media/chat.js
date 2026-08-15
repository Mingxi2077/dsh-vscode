// DSH chat webview 前端（纯 JS，无依赖）
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  // ---- i18n：界面文案跟随 <html lang>（webviewHtml 按 VS Code 语言注入） ----
  const LANG = (document.documentElement.lang || "en").toLowerCase();
  const I18N = LANG.startsWith("zh")
    ? {
        emptyHint: "<strong>DSH 助手</strong><br>输入消息让 DSH 在当前项目中工作。" +
          "<br><br>· <kbd>Enter</kbd> 发送，<kbd>Shift+Enter</kbd> 换行" +
          "<br>· 选中代码后点 <b>📎 选中代码</b> 加入上下文" +
          "<br>· 会话自动保存在本机，可随时切换",
        copy: "复制", copied: "已复制",
        insertCode: "插入代码", applyToFile: "应用到文件",
        traceSummary: "思维链与工具调用（{n} 项{tool}）", traceToolCount: "，工具 {n} 个",
        goalCreated: "🎯 已创建", goalUpdated: "✏️ 已更新", goalPaused: "⏸ 已暂停",
        goalResumed: "▶️ 已恢复", goalCompleted: "✅ 已完成", goalBlocked: "🚧 受阻",
        think: "思考", thinking: "思考过程",
        model: "模型", input: "输入", output: "输出", cache: "缓存", reasoning: "推理",
        toolRunning: "运行中…", toolDone: "完成",
        working: "DSH 正在工作", turn: "第 {n} 轮", step: "第 {n} 步",
        todoDone: "已完成", todoInProgress: "进行中", todoPending: "待办",
        goalLiveCreated: "🎯 目标已创建", goalLiveUpdated: "✏️ 目标已更新", goalLivePaused: "⏸ 目标已暂停",
        goalLiveResumed: "▶️ 目标已恢复", goalLiveCompleted: "✅ 目标已完成", goalLiveBlocked: "🚧 目标受阻",
        typing: "DSH 正在工作…", runningSec: "运行中 {n}s",
      }
    : {
        emptyHint: "<strong>DSH Assistant</strong><br>Type a message and DSH works in your project." +
          "<br><br>· <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for newline" +
          "<br>· Select code then click <b>📎 Selection</b> to add context" +
          "<br>· Sessions save locally, switch anytime",
        copy: "Copy", copied: "Copied",
        insertCode: "Insert Code", applyToFile: "Apply to File",
        traceSummary: "Thinking & tool calls ({n} items{tool})", traceToolCount: ", {n} tools",
        goalCreated: "🎯 created", goalUpdated: "✏️ updated", goalPaused: "⏸ paused",
        goalResumed: "▶️ resumed", goalCompleted: "✅ completed", goalBlocked: "🚧 blocked",
        think: "Think", thinking: "Thinking",
        model: "Model", input: "In", output: "Out", cache: "Cache", reasoning: "Reason",
        toolRunning: "running…", toolDone: "done",
        working: "DSH is working", turn: "turn {n}", step: "step {n}",
        todoDone: "Done", todoInProgress: "In progress", todoPending: "Todo",
        goalLiveCreated: "🎯 Goal created", goalLiveUpdated: "✏️ Goal updated", goalLivePaused: "⏸ Goal paused",
        goalLiveResumed: "▶️ Goal resumed", goalLiveCompleted: "✅ Goal completed", goalLiveBlocked: "🚧 Goal blocked",
        typing: "DSH is working…", runningSec: "running {n}s",
      };

  const t = (key, vars) => {
    let s = I18N[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace("{" + k + "}", String(v));
    return s;
  };

  const state = {
    sessionId: "",
    title: "",
    messages: [],
    blocks: [],
    running: false,
    busy: false,
    runStartedAt: 0,
    folder: "",
    usage: null, // {input, output, cacheRead, reasoning, model, provider, effort}
    selection: null,
    effort: "",
    skills: [],
  };

  const live = {
    turn: 0,
    step: 0,
    reasoning: new Map(), // 块索引 → 思考文本
    texts: new Map(), // 块索引 → 文本草稿
    tools: new Map(), // callId → {name,args,status,result,isError}
    goals: new Map(), // goalId → {objective, operation}
    todos: [], // 任务清单快照 [{content,status}]
    order: [], // 展示顺序：["reasoning","text","tool:<callId>","goal:<id>"]
    sealed: new Set(), // 已收到权威完整块（block-end）的键，后续增量不再累加
  };

  const els = {
    messages: document.getElementById("messages"),
    input: document.getElementById("input"),
    send: document.getElementById("btn-send"),
    cancel: document.getElementById("btn-cancel"),
    status: document.getElementById("status"),
    sessionTitle: document.getElementById("session-title"),
    sessionId: document.getElementById("session-id"),
    contextBar: document.getElementById("context-bar"),
    usageBar: document.getElementById("usage-bar"),
    btnNew: document.getElementById("btn-new"),
    btnSessions: document.getElementById("btn-sessions"),
    btnAttach: document.getElementById("btn-attach"),
    btnFile: document.getElementById("btn-file"),
  };

  let elapsedTimer = null;
  let typingEl = null;

  function post(message) {
    vscode.postMessage(message);
  }

  // Markdown 渲染与文件引用链接化见 markdown.js（DSHMarkdown）

  // ---------------- 渲染 ----------------

  function scrollToBottom() {
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  /** 智能滚动：用户已在底部附近才自动跟随，往上翻历史时不打断。 */
  function smartScrollToBottom() {
    const el = els.messages;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 48) {
      el.scrollTop = el.scrollHeight;
    }
  }

  function render() {
    els.messages.innerHTML = "";
    if (state.messages.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.innerHTML = t("emptyHint");
      els.messages.appendChild(hint);
    } else {
      for (const m of state.messages) {
        els.messages.appendChild(renderMessage(m));
      }
    }
    scrollToBottom();
  }

  function renderMessage(m) {
    const el = document.createElement("div");
    el.className = "msg " + m.role;
    el.dataset.id = m.id;

    if (m.role === "user") {
      el.textContent = m.content;
      return el;
    }
    if (m.role === "system") {
      el.textContent = m.content;
      return el;
    }

    const header = document.createElement("div");
    header.className = "msg-header";
    const role = document.createElement("span");
    role.className = "msg-role";
    role.textContent = "DSH";
    const actions = document.createElement("span");
    actions.className = "msg-actions";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = t("copy");
    copyBtn.dataset.act = "copy";
    const insertBtn = document.createElement("button");
    insertBtn.textContent = t("insertCode");
    insertBtn.dataset.act = "insert";
    const applyBtn = document.createElement("button");
    applyBtn.textContent = t("applyToFile");
    applyBtn.dataset.act = "apply";
    actions.appendChild(copyBtn);
    actions.appendChild(insertBtn);
    actions.appendChild(applyBtn);
    header.appendChild(role);
    header.appendChild(actions);

    const content = document.createElement("div");
    content.className = "msg-content";
    content.innerHTML = DSHMarkdown.renderMarkdown(m.content);
    DSHMarkdown.linkifyFileRefs(content);

    el.appendChild(header);
    if (m.trace && m.trace.length) {
      el.appendChild(renderTrace(m.trace));
    }
    el.appendChild(content);
    return el;
  }

  /** 把思维链轨迹渲染成可折叠区域（默认收起）。 */
  function renderTrace(blocks) {
    const details = document.createElement("details");
    details.className = "msg-trace";
    const summary = document.createElement("summary");
    const toolCount = blocks.filter((b) => b.kind === "tool").length;
    summary.textContent = t("traceSummary", {
      n: blocks.length,
      tool: toolCount ? t("traceToolCount", { n: toolCount }) : "",
    });
    details.appendChild(summary);

    for (const b of blocks) {
      if (b.kind === "goal") {
        const badge = {
          create: t("goalCreated"), update: t("goalUpdated"), edit: t("goalUpdated"),
          pause: t("goalPaused"), resume: t("goalResumed"), complete: t("goalCompleted"),
          blocked: t("goalBlocked"),
        }[b.operation] || b.operation;
        const goal = document.createElement("div");
        goal.className = "msg-trace-goal" + (b.operation === "complete" ? " is-done" : "");
        const badgeEl = document.createElement("span");
        badgeEl.className = "msg-trace-goal-badge";
        badgeEl.textContent = badge;
        const obj = document.createElement("span");
        obj.className = "msg-trace-goal-objective";
        obj.textContent = b.objective;
        goal.appendChild(badgeEl);
        goal.appendChild(obj);
        details.appendChild(goal);
      } else if (b.kind === "reasoning") {
        const rd = document.createElement("details");
        rd.className = "msg-trace-reasoning";
        rd.open = false;
        const rs = document.createElement("summary");
        rs.textContent = t("think");
        const pre = document.createElement("pre");
        pre.textContent = b.text || "";
        rd.appendChild(rs);
        rd.appendChild(pre);
        details.appendChild(rd);
      } else if (b.kind === "tool") {
        const card = document.createElement("div");
        card.className = "msg-trace-tool" + (b.isError ? " is-error" : "");
        const name = document.createElement("span");
        name.className = "msg-trace-tool-name";
        name.textContent = "⚙ " + (b.name || "tool");
        card.appendChild(name);
        if (b.args) {
          const args = document.createElement("code");
          args.textContent = b.args.slice(0, 200);
          card.appendChild(args);
        }
        if (b.result) {
          const res = document.createElement("div");
          res.className = "msg-trace-tool-result";
          res.textContent = b.result.slice(0, 200);
          card.appendChild(res);
        }
        details.appendChild(card);
      }
    }
    return details;
  }

  function fmtNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  /** 渲染输入区上方的用量/模型状态条。 */
  function renderUsageBar() {
    const bar = els.usageBar;
    if (!bar) return;
    const u = state.usage;
    if (!u) {
      bar.hidden = true;
      return;
    }
    const parts = [];
    if (u.model) parts.push(t("model") + " " + u.model + (u.effort ? " · " + u.effort : ""));
    else if (state.selection && state.selection.model) {
      parts.push(t("model") + " " + state.selection.model + (state.effort ? " · " + state.effort : ""));
    }
    parts.push(t("input") + " " + fmtNum(u.input));
    parts.push(t("output") + " " + fmtNum(u.output));
    if (u.cacheRead > 0) {
      const total = u.cacheRead + u.input;
      parts.push(t("cache") + " " + Math.round((u.cacheRead / total) * 100) + "%");
    }
    if (u.reasoning > 0) parts.push(t("reasoning") + " " + fmtNum(u.reasoning));
    bar.textContent = parts.join(" · ");
    bar.hidden = false;
  }

  function renderContextBar() {
    els.contextBar.innerHTML = "";
    for (const b of state.blocks) {
      const chip = document.createElement("span");
      chip.className = "chip";
      const label = document.createElement("span");
      label.textContent = b.label;
      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.dataset.blockId = b.id;
      chip.appendChild(label);
      chip.appendChild(rm);
      els.contextBar.appendChild(chip);
    }
  }

  // ---------------- 实时进度（思维链 / 工具调用） ----------------

  let liveEl = null;

  function resetLive() {
    live.turn = 0;
    live.step = 0;
    live.reasoning.clear();
    live.texts.clear();
    live.tools.clear();
    live.goals.clear();
    live.todos = [];
    live.order = [];
    live.sealed.clear();
  }

  function ensureLiveEl() {
    if (liveEl && liveEl.isConnected) return liveEl;
    liveEl = document.createElement("div");
    liveEl.className = "msg assistant live-feed";
    els.messages.appendChild(liveEl);
    smartScrollToBottom();
    return liveEl;
  }

  function applyProgress(msg) {
    if (!state.running) return;
    switch (msg.kind) {
      case "turn":
        live.turn = msg.turn;
        live.step = 0;
        break;
      case "step":
        live.step = msg.step;
        live.turn = msg.turn;
        break;
      case "goal": {
        // DSH 目标状态：同一 goal 合并为一个卡片，操作徽标随最新状态变化
        if (!live.goals.has(msg.id)) live.order.push("goal:" + msg.id);
        live.goals.set(msg.id, { objective: msg.objective, operation: msg.operation });
        break;
      }
      case "todo": {
        // 任务清单全量快照：整体替换（每次 todo/write 都是完整清单）
        live.todos = msg.todos || [];
        break;
      }
      case "block": {
        // 权威完整块（assistant/chunk block-end）：替换内容并封存键，防增量双写
        if (msg.blockType === "reasoning" && msg.text) {
          live.sealed.add(msg.key);
          if (!live.reasoning.has(msg.key)) live.order.push("reasoning:" + msg.key);
          live.reasoning.set(msg.key, msg.text);
        } else if (msg.blockType === "text" && msg.text) {
          live.sealed.add(msg.key);
          if (!live.texts.has(msg.key)) live.order.push("text:" + msg.key);
          live.texts.set(msg.key, msg.text);
        } else if (msg.blockType === "tool-call") {
          const id = msg.callId || msg.key;
          if (!live.tools.has(id)) {
            live.order.push("tool:" + id);
            live.tools.set(id, { name: msg.name || "tool", args: msg.args || "", status: t("toolRunning"), result: "", isError: false });
          } else {
            const tool = live.tools.get(id);
            if (msg.args) tool.args = msg.args;
            if (msg.name) tool.name = msg.name;
          }
        }
        break;
      }
      case "tool": {
        if (!live.tools.has(msg.callId)) {
          live.order.push("tool:" + msg.callId);
          live.tools.set(msg.callId, { name: msg.name, args: msg.args, status: t("toolRunning"), result: "", isError: false });
        } else {
          const tool = live.tools.get(msg.callId);
          if (msg.args) tool.args = msg.args;
        }
        break;
      }
      case "tool-result": {
        const tool = live.tools.get(msg.callId);
        if (tool) {
          tool.status = t("toolDone");
          tool.isError = !!msg.isError;
          tool.result = msg.summary;
        }
        break;
      }
      case "reasoning":
        if (live.sealed.has(msg.key)) break;
        if (!live.reasoning.has(msg.key)) live.order.push("reasoning:" + msg.key);
        live.reasoning.set(msg.key, (live.reasoning.get(msg.key) || "") + msg.text);
        break;
      case "text":
        if (live.sealed.has(msg.key)) break;
        if (!live.texts.has(msg.key)) live.order.push("text:" + msg.key);
        live.texts.set(msg.key, (live.texts.get(msg.key) || "") + msg.text);
        break;
      case "assistant": {
        // 完整快照：权威替换各块（用独立 snap- 前缀键，避免与 chunk 键冲突）
        const blocks = msg.blocks || [];
        blocks.forEach((b, i) => {
          if (b.type === "reasoning") {
            const k = "snap-" + i;
            if (!live.reasoning.has(k)) live.order.push("reasoning:" + k);
            live.reasoning.set(k, b.text || "");
          } else if (b.type === "text") {
            const k = "snap-" + i;
            if (!live.texts.has(k)) live.order.push("text:" + k);
            live.texts.set(k, b.text || "");
          } else if (b.type === "tool-call") {
            const id = "snap-" + i;
            if (!live.tools.has(id)) live.order.push("tool:" + id);
            live.tools.set(id, { name: b.name || "tool", args: b.arguments || "", status: t("toolRunning"), result: "", isError: false });
          }
        });
        break;
      }
      case "done":
        break;
    }
    renderLive();
  }

  function renderLive() {
    const el = ensureLiveEl();
    el.innerHTML = "";
    const header = document.createElement("div");
    header.className = "live-header";
    let headText = t("working");
    if (live.turn) {
      headText += " · " + t("turn", { n: live.turn });
      if (live.step) headText += " · " + t("step", { n: live.step });
    }
    header.textContent = headText + "…";
    el.appendChild(header);

    // 任务清单（todo/write 全量快照）优先展示
    if (live.todos.length) {
      const todoBox = document.createElement("div");
      todoBox.className = "live-todos";
      for (const item of live.todos) {
        const row = document.createElement("div");
        row.className = "live-todo " + ("live-todo-" + (item.status || "pending"));
        const mark = {
          completed: "✅",
          in_progress: "🔄",
          pending: "⬜",
        }[item.status] || "⬜";
        const markEl = document.createElement("span");
        markEl.className = "live-todo-mark";
        markEl.textContent = mark;
        const contentEl = document.createElement("span");
        contentEl.className = "live-todo-content";
        contentEl.textContent = item.content;
        contentEl.title = { completed: t("todoDone"), in_progress: t("todoInProgress"), pending: t("todoPending") }[item.status] || item.status;
        row.appendChild(markEl);
        row.appendChild(contentEl);
        todoBox.appendChild(row);
      }
      el.appendChild(todoBox);
    }

    for (const key of live.order) {
      if (key.startsWith("goal:")) {
        const g = live.goals.get(key.slice(5));
        if (!g) continue;
        const badge = {
          create: t("goalLiveCreated"), update: t("goalLiveUpdated"), edit: t("goalLiveUpdated"),
          pause: t("goalLivePaused"), resume: t("goalLiveResumed"), complete: t("goalLiveCompleted"),
          blocked: t("goalLiveBlocked"),
        }[g.operation] || ("🔄 " + g.operation);
        const card = document.createElement("div");
        card.className = "live-goal" + (g.operation === "complete" ? " is-done" : "");
        const row = document.createElement("div");
        row.className = "live-goal-row";
        const badgeEl = document.createElement("span");
        badgeEl.className = "live-goal-badge";
        badgeEl.textContent = badge;
        const obj = document.createElement("span");
        obj.className = "live-goal-objective";
        obj.textContent = g.objective;
        row.appendChild(badgeEl);
        row.appendChild(obj);
        card.appendChild(row);
        el.appendChild(card);
      } else if (key.startsWith("reasoning:")) {
        const k = key.slice("reasoning:".length);
        const text = live.reasoning.get(k) || "";
        const details = document.createElement("details");
        details.className = "live-reasoning";
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = t("thinking");
        const pre = document.createElement("pre");
        pre.textContent = text || "…";
        details.appendChild(summary);
        details.appendChild(pre);
        el.appendChild(details);
      } else if (key.startsWith("text:")) {
        const k = key.slice("text:".length);
        const text = live.texts.get(k) || "";
        const div = document.createElement("div");
        div.className = "live-text";
        div.textContent = text || "…";
        el.appendChild(div);
      } else if (key.startsWith("tool:")) {
        const tool = live.tools.get(key.slice(5));
        if (!tool) continue;
        const card = document.createElement("div");
        card.className = "live-tool" + (tool.isError ? " is-error" : "");
        const row = document.createElement("div");
        row.className = "live-tool-row";
        const name = document.createElement("span");
        name.className = "live-tool-name";
        name.textContent = "⚙ " + tool.name;
        const status = document.createElement("span");
        status.className = "live-tool-status";
        status.textContent = tool.status;
        row.appendChild(name);
        row.appendChild(status);
        card.appendChild(row);
        if (tool.args) {
          const args = document.createElement("code");
          args.textContent = tool.args.slice(0, 200);
          card.appendChild(args);
        }
        if (tool.result) {
          const res = document.createElement("div");
          res.className = "live-tool-result";
          res.textContent = tool.result.slice(0, 200);
          card.appendChild(res);
        }
        el.appendChild(card);
      }
    }
    smartScrollToBottom();
  }

  function clearLive() {
    if (liveEl) {
      liveEl.remove();
      liveEl = null;
    }
    resetLive();
  }

  function showTyping() {
    hideTyping();
    typingEl = document.createElement("div");
    typingEl.className = "msg system typing";
    typingEl.textContent = t("typing");
    els.messages.appendChild(typingEl);
    smartScrollToBottom();
  }

  function hideTyping() {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function updateActionState() {
    els.send.disabled = state.running || state.busy;
    els.cancel.hidden = !state.running;
    // busy（如 /compact）期间不允许新建/切换会话，否则压缩结果会套到新会话上
    els.btnNew.disabled = state.busy;
    els.btnSessions.disabled = state.busy;
  }

  function setBusy(busy) {
    state.busy = !!busy;
    updateActionState();
  }

  function setRunning(running) {
    state.running = running;
    updateActionState();
    if (running) {
      state.runStartedAt = Date.now();
      updateElapsed();
      elapsedTimer = setInterval(updateElapsed, 1000);
      showTyping();
    } else {
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
      hideTyping();
      els.status.textContent = "";
      clearLive();
    }
  }

  function updateElapsed() {
    const sec = Math.floor((Date.now() - state.runStartedAt) / 1000);
    els.status.textContent = t("runningSec", { n: sec });
  }

  // ---------------- 输入 ----------------

  function sendInput() {
    const text = els.input.value;
    if (!text.trim() || state.running || state.busy) return;
    const cmdMatch = text.trim().match(/^\/(help|clear|memory|edit-memory|remember|context|provider|model|effort|skills|compact|status)(\s|$)/);
    if (cmdMatch) {
      els.input.value = "";
      vscode.setState({ draft: "" });
      post({ type: "command", text: text.trim() });
      return;
    }
    els.input.value = "";
    vscode.setState({ draft: "" });
    post({ type: "send", text });
  }

  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
  });

  els.input.addEventListener("input", () => {
    vscode.setState({ draft: els.input.value });
  });

  els.send.addEventListener("click", sendInput);
  els.cancel.addEventListener("click", () => post({ type: "cancel" }));
  els.btnNew.addEventListener("click", () => post({ type: "newSession" }));
  els.btnSessions.addEventListener("click", () => post({ type: "listSessions" }));
  els.btnAttach.addEventListener("click", () => post({ type: "attachSelection" }));
  els.btnFile.addEventListener("click", () => post({ type: "attachOpenFile" }));

  els.contextBar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-block-id]");
    if (btn) {
      post({ type: "removeContext", id: btn.dataset.blockId });
    }
  });

  els.messages.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      const msgEl = btn.closest(".msg");
      const id = msgEl ? msgEl.dataset.id : "";
      const msg = state.messages.find((m) => m.id === id);
      if (!msg) return;
      if (btn.dataset.act === "copy") {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(msg.content).then(() => {
            btn.textContent = t("copied");
            setTimeout(() => (btn.textContent = t("copy")), 1200);
          }).catch(() => {
            // 剪贴板不可用时静默降级，避免 webview 出现未处理 Promise 拒绝
          });
        }
      } else if (btn.dataset.act === "insert") {
        post({ type: "insertCode", id });
      } else if (btn.dataset.act === "apply") {
        post({ type: "applyToFiles", id });
      }
    }
    const link = e.target.closest("a[href^='http']");
    if (link) {
      e.preventDefault();
      post({ type: "openExternal", url: link.getAttribute("href") });
      return;
    }
    const fileRef = e.target.closest("a.file-ref");
    if (fileRef) {
      e.preventDefault();
      const line = fileRef.dataset.line ? Number(fileRef.dataset.line) : undefined;
      post({ type: "openFile", path: fileRef.dataset.path, line });
    }
  });

  // ---------------- 主线程消息 ----------------

  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "init":
        state.sessionId = msg.sessionId;
        state.title = msg.title;
        state.messages = msg.messages || [];
        state.blocks = msg.blocks || [];
        state.folder = msg.folder || "";
        state.selection = msg.selection || null;
        state.effort = msg.effort || "";
        state.usage = msg.usage || null;
        state.skills = msg.skills || [];
        setRunning(!!msg.running);
        setBusy(!!msg.busy);
        renderContextBar();
        renderUsageBar();
        render();
        break;
      case "progress":
        applyProgress(msg.msg);
        break;
      case "usage":
        state.usage = msg.usage || null;
        renderUsageBar();
        break;
      case "selectionChanged":
        state.selection = msg.selection || null;
        state.effort = msg.effort || "";
        renderUsageBar();
        break;
      case "appendMessage":
        state.messages.push(msg.message);
        render();
        break;
      case "appendMessages":
        state.messages = state.messages.concat(msg.messages || []);
        render();
        break;
      case "resetMessages":
        state.messages = [];
        render();
        break;
      case "running":
        setRunning(!!msg.running);
        break;
      case "busy":
        setBusy(!!msg.busy);
        break;
      case "sessionChanged":
        state.sessionId = msg.sessionId;
        state.title = msg.title;
        els.sessionTitle.textContent = msg.title;
        els.sessionId.textContent = msg.sessionId.slice(0, 8);
        break;
      case "contextChanged":
        state.blocks = msg.blocks || [];
        renderContextBar();
        break;
      case "setDraft":
        els.input.value = typeof msg.text === "string" ? msg.text : "";
        els.input.focus();
        break;
    }
  });

  // ---------------- 启动 ----------------

  const prev = vscode.getState();
  if (prev && typeof prev.draft === "string") {
    els.input.value = prev.draft;
  }
  els.input.focus();
  post({ type: "ready" });
})();
