// Tiny dependency-free Markdown renderer for agent output.
//
// Supports: fenced code blocks, inline code, headings, bold/italic,
// links (rendered inert — clicks are routed through the opener in main.js),
// unordered/ordered lists, blockquotes, and horizontal rules. Everything is
// HTML-escaped first, so agent output can never inject markup.

"use strict";

function escapeHtml(s) {
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

function flushList(state, html) {
  if (state.list) {
    html.push(state.list === "ul" ? "</ul>" : "</ol>");
    state.list = null;
  }
}

export function renderMarkdown(src) {
  const lines = String(src).split("\n");
  const html = [];
  const state = { list: null };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      flushList(state, html);
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      const cls = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      html.push(`<pre${cls}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList(state, html);
      const level = Math.min(heading[1].length + 2, 6); // demote: h1 -> h3
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flushList(state, html);
      html.push("<hr>");
      i++;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushList(state, html);
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      i++;
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (state.list !== kind) {
        flushList(state, html);
        html.push(kind === "ul" ? "<ul>" : "<ol>");
        state.list = kind;
      }
      html.push(`<li>${renderInline((ul || ol)[1])}</li>`);
      i++;
      continue;
    }

    flushList(state, html);
    if (line.trim() !== "") {
      html.push(`<p>${renderInline(line)}</p>`);
    }
    i++;
  }

  flushList(state, html);
  return html.join("\n");
}
