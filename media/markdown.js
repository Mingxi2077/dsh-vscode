// DSH 极简 Markdown 渲染器 + 文件引用链接化（Webview 使用，挂在全局 DSHMarkdown）
(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInline(text) {
    let t = escapeHtml(text);
    t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    t = t.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
    );
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return t;
  }

  function renderMarkdown(src) {
    const lines = String(src).replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let para = [];
    let inCode = false;
    let codeLang = "";
    let codeLines = [];
    let list = null;
    let quote = [];

    const flushPara = () => {
      if (para.length) {
        out.push("<p>" + renderInline(para.join(" ")) + "</p>");
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        out.push(
          "<" + list.tag + ">" +
            list.items.map((i) => "<li>" + i + "</li>").join("") +
            "</" + list.tag + ">"
        );
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push("<blockquote>" + quote.map((q) => "<p>" + q + "</p>").join("") + "</blockquote>");
        quote = [];
      }
    };
    const flushAll = () => {
      flushPara();
      flushList();
      flushQuote();
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (inCode) {
        if (/^```/.test(line)) {
          out.push(
            "<pre><code>" +
              (codeLang ? ' class="lang-' + escapeHtml(codeLang) + '"' : "") +
              ">" +
              escapeHtml(codeLines.join("\n")) +
              "</code></pre>"
          );
          inCode = false;
          codeLang = "";
          codeLines = [];
        } else {
          codeLines.push(line);
        }
        continue;
      }
      const fence = line.match(/^```(\w*)/);
      if (fence) {
        flushAll();
        inCode = true;
        codeLang = fence[1];
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === "") {
        flushAll();
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        flushAll();
        out.push("<hr>");
        continue;
      }
      const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushAll();
        out.push("<h" + h[1].length + ">" + renderInline(h[2]) + "</h" + h[1].length + ">");
        continue;
      }
      const q = trimmed.match(/^>\s?(.*)$/);
      if (q) {
        flushPara();
        flushList();
        quote.push(renderInline(q[1]));
        continue;
      }
      const ul = trimmed.match(/^([-*+])\s+(.*)$/);
      if (ul) {
        flushPara();
        flushQuote();
        if (list && list.tag !== "ul") flushList();
        if (!list) list = { tag: "ul", items: [] };
        list.items.push(renderInline(ul[2]));
        continue;
      }
      const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        flushQuote();
        if (list && list.tag !== "ol") flushList();
        if (!list) list = { tag: "ol", items: [] };
        list.items.push(renderInline(ol[1]));
        continue;
      }
      flushList();
      flushQuote();
      para.push(trimmed);
    }
    if (inCode) {
      out.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
    }
    flushAll();
    return out.join("\n");
  }

  const FILE_REF_RE =
    /(\b[A-Za-z0-9_][A-Za-z0-9_.\/\\-]*\.(?:tsx?|jsx?|py|rs|go|java|c(?:pp|xx)?|h(?:pp|xx)?|json|md|ya?ml|css|html?|vue|svelte|sh|ps1|sql|toml|ini|txt|rb|php|cs|kt|swift|dart|scss|less|xml|env))\b(?::(\d+))?/g;

  /** 把回答中的文件路径（含可选 :行号）转为可点击链接。 */
  function linkifyFileRefs(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const el = node.parentElement;
        if (el && el.closest("pre, a, .file-ref, .live-feed")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      let m;
      let last = 0;
      let html = "";
      let changed = false;
      FILE_REF_RE.lastIndex = 0;
      while ((m = FILE_REF_RE.exec(text))) {
        changed = true;
        html += escapeHtml(text.slice(last, m.index));
        const line = m[2] || "";
        html +=
          '<a class="file-ref" data-path="' +
          escapeHtml(m[1]) +
          '" data-line="' +
          escapeHtml(line) +
          '">' +
          escapeHtml(m[1]) +
          (line ? ":" + line : "") +
          "</a>";
        last = m.index + m[0].length;
      }
      if (changed) {
        html += escapeHtml(text.slice(last));
        const span = document.createElement("span");
        span.innerHTML = html;
        node.parentNode.replaceChild(span, node);
      }
    }
  }

  global.DSHMarkdown = {
    escapeHtml: escapeHtml,
    renderMarkdown: renderMarkdown,
    linkifyFileRefs: linkifyFileRefs,
  };
})(globalThis);
