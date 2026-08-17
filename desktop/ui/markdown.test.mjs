import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownBlocks, renderMarkdown } from "./markdown.js";
import { unifiedLineDiff, lcsLineDiff } from "./diff.js";

test("joins wrapped prose into one paragraph", () => {
  const html = renderMarkdown("Hello world\nthis is wrapped\nprose.\n\nNext paragraph.");
  assert.match(html, /<p>Hello world this is wrapped prose\.<\/p>/);
  assert.match(html, /<p>Next paragraph\.<\/p>/);
  assert.equal((html.match(/<p>/g) || []).length, 2);
});

test("does not treat every non-blank line as its own paragraph", () => {
  const html = renderMarkdown("one\ntwo\nthree");
  assert.equal((html.match(/<p>/g) || []).length, 1);
  assert.match(html, /<p>one two three<\/p>/);
});

test("keeps fenced code as a single block", () => {
  const html = renderMarkdown("```js\nconst x = 1;\n```");
  assert.match(html, /<pre data-lang="js">/);
  assert.match(html, /<code>const x = 1;<\/code>/);
  assert.match(html, /data-copy="pre"/);
});

test("renders pipe tables", () => {
  const html = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test("joins consecutive list items", () => {
  const html = renderMarkdown("- a\n- b\n- c");
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
});

test("joins consecutive blockquote lines", () => {
  const html = renderMarkdown("> one\n> two");
  assert.match(html, /<blockquote>one<br>two<\/blockquote>/);
});

test("last block is open-able while earlier blocks stay sealed", () => {
  const blocks = parseMarkdownBlocks("# Title\n\nHello\nworld\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[1].type, "p");
  assert.match(blocks[1].html, /Hello world/);
});

test("streaming prose stays one open paragraph until a blank line", () => {
  assert.equal(parseMarkdownBlocks("Hel").length, 1);
  assert.equal(parseMarkdownBlocks("Hello\nwor").length, 1);
  const afterBreak = parseMarkdownBlocks("Hello\nworld\n\nNext");
  assert.equal(afterBreak.length, 2);
  assert.equal(afterBreak[0].type, "p");
  assert.equal(afterBreak[1].type, "p");
});

test("unclosed fence stays a single open block", () => {
  const blocks = parseMarkdownBlocks("intro\n\n```rs\nfn main() {\n");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, "fence");
  assert.equal(blocks[1].closed, false);
});

test("escapes HTML in prose and fences", () => {
  const html = renderMarkdown("use <script>alert(1)</script>\n\n```\n<a>\n```");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;a&gt;/);
});

test("unified diff reports added and deleted lines", () => {
  const diff = unifiedLineDiff("keep\nold\ntail", "keep\nnew\ntail");
  assert.equal(diff.added, 1);
  assert.equal(diff.deleted, 1);
  assert.deepEqual(
    diff.lines.map((l) => [l.type, l.text]),
    [
      ["ctx", "keep"],
      ["del", "old"],
      ["add", "new"],
      ["ctx", "tail"],
    ]
  );
});

test("unified diff keeps the changed line even in a large file", () => {
  const oldLines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const newLines = oldLines.slice();
  newLines[150] = "CHANGED";
  const diff = unifiedLineDiff(oldLines.join("\n"), newLines.join("\n"));
  assert.equal(diff.added, 1);
  assert.equal(diff.deleted, 1);
  assert.ok(diff.lines.some((l) => l.type === "add" && l.text === "CHANGED"));
  assert.ok(diff.lines.some((l) => l.type === "skip"));
});

test("LCS matches a simple replace", () => {
  const ops = lcsLineDiff(["keep", "old", "tail"], ["keep", "new", "tail"]);
  assert.deepEqual(ops.map((o) => o.type), ["ctx", "del", "add", "ctx"]);
});
