// Tiny dependency-free Markdown renderer for agent output.
//
// Supports: fenced code blocks, inline code, headings, bold/italic,
// links (rendered inert — clicks are routed through the opener in main.js),
// unordered/ordered lists, blockquotes, and horizontal rules. Everything is
// HTML-escaped first, so agent output can never inject markup.
//
// Consecutive prose lines are joined into a single <p> (wrapped agent output
// used to become a stack of one-liners). Incremental streaming keeps sealed
// blocks in the DOM and only rebuilds the last open block.

"use strict";

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text) {
  let out = escapeHtml(text);
  // Inline code first so other spans don't apply inside it.
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" data-external>$1</a>'
  );
  // Bare URLs.
  out = out.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" data-external>$2</a>'
  );
  return out;
}

function isFenceOpen(line) {
  return /^\s*```(\S*)\s*$/.test(line);
}

function isFenceClose(line) {
  return /^\s*```\s*$/.test(line);
}

function isHeading(line) {
  return /^(#{1,6})\s+(.*)$/.test(line);
}

function isHr(line) {
  return /^\s*(---|\*\*\*)\s*$/.test(line);
}

function isQuote(line) {
  return /^\s*>\s?/.test(line);
}

function isUl(line) {
  return /^\s*[-*+]\s+/.test(line);
}

function isOl(line) {
  return /^\s*\d+[.)]\s+/.test(line);
}

function isListItem(line) {
  return isUl(line) || isOl(line);
}

function isBlockBoundary(line) {
  return (
    isFenceOpen(line) ||
    isHeading(line) ||
    isHr(line) ||
    isQuote(line) ||
    isListItem(line)
  );
}

function renderFence(lang, body) {
  const safeLang = lang ? escapeHtml(lang) : "";
  const langAttr = safeLang ? ` data-lang="${safeLang}"` : "";
  const langChip = safeLang ? `<span class="pre-lang">${safeLang}</span>` : "";
  return (
    `<pre${langAttr}>` +
    `<div class="pre-bar">${langChip}` +
    `<button type="button" class="copy-btn" data-copy="pre" aria-label="Copy code">Copy</button>` +
    `</div>` +
    `<code>${escapeHtml(body)}</code>` +
    `</pre>`
  );
}

function joinParagraph(lines) {
  const html = [];
  for (let i = 0; i < lines.length; i++) {
    const hard = / {2}$/.test(lines[i]);
    const text = lines[i].replace(/ {2}$/, "");
    if (i > 0) html.push(hard ? "<br>" : " ");
    html.push(renderInline(text));
  }
  return `<p>${html.join("")}</p>`;
}

/**
 * Walk `src` into discrete block objects. The last block is treated as open
 * by the stream renderer (it may still grow); earlier blocks are sealed.
 */
export function parseMarkdownBlocks(src) {
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (isFenceClose(lines[i])) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: "fence", closed, html: renderFence(lang, body.join("\n")) });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // demote: h1 -> h3
      blocks.push({
        type: "heading",
        html: `<h${level}>${renderInline(heading[2])}</h${level}>`,
      });
      i++;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ type: "hr", html: "<hr>" });
      i++;
      continue;
    }

    if (isQuote(line)) {
      const qlines = [];
      while (i < lines.length && isQuote(lines[i])) {
        qlines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({
        type: "quote",
        html: `<blockquote>${qlines.map(renderInline).join("<br>")}</blockquote>`,
      });
      continue;
    }

    if (isListItem(line)) {
      const kind = isUl(line) ? "ul" : "ol";
      const items = [];
      while (i < lines.length) {
        const ul = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const ol = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        const hit = kind === "ul" ? ul : ol;
        if (!hit) break;
        items.push(`<li>${renderInline(hit[1])}</li>`);
        i++;
      }
      const tag = kind === "ul" ? "ul" : "ol";
      blocks.push({ type: kind, html: `<${tag}>${items.join("")}</${tag}>` });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const plines = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockBoundary(lines[i])) {
      plines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", html: joinParagraph(plines) });
  }

  return blocks;
}

export function renderMarkdown(src) {
  return parseMarkdownBlocks(src)
    .map((b) => b.html)
    .join("\n");
}

export function createMdStream() {
  return { sealed: 0, openEls: [] };
}

function mountHtml(container, html, before) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const nodes = [];
  while (tmp.firstChild) {
    const n = tmp.firstChild;
    container.insertBefore(n, before || null);
    nodes.push(n);
  }
  return nodes;
}

function removeNodes(nodes) {
  for (const n of nodes) n.remove();
}

/**
 * Rebuild only the last open markdown block. Sealed blocks stay in the DOM
 * so streaming does not wipe selection, copy buttons, or layout on every chunk.
 */
export function updateMdStream(container, stream, src) {
  const blocks = parseMarkdownBlocks(src);
  const sealed = blocks.length ? blocks.slice(0, -1) : [];
  const open = blocks.length ? blocks[blocks.length - 1] : null;

  while (stream.sealed < sealed.length) {
    const html = sealed[stream.sealed].html;
    if (stream.openEls.length) {
      const next = stream.openEls[stream.openEls.length - 1].nextSibling;
      removeNodes(stream.openEls);
      stream.openEls = [];
      mountHtml(container, html, next);
    } else {
      mountHtml(container, html, null);
    }
    stream.sealed++;
  }

  removeNodes(stream.openEls);
  stream.openEls = [];
  if (open) stream.openEls = mountHtml(container, open.html, null);
}
