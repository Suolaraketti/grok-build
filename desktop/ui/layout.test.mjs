import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(dir, "index.html"), "utf8");
const css = readFileSync(join(dir, "style.css"), "utf8");

test("empty-state lives inside #chat-scroll, not over the composer", () => {
  const scroll = html.indexOf('id="chat-scroll"');
  const empty = html.indexOf('id="empty-state"');
  const composer = html.indexOf('id="composer"');
  const scrollClose = html.indexOf("</div>", html.indexOf('id="jump-latest"'));
  assert.ok(scroll > 0 && empty > scroll, "empty-state must be inside #chat-scroll");
  assert.ok(empty < scrollClose, "empty-state must close before leaving #chat-scroll");
  assert.ok(composer > scrollClose, "composer must sit after #chat-scroll");
});

test("send button is type=button so it cannot submit a phantom form", () => {
  assert.match(html, /id="send-btn"[^>]*type="button"/);
});

test("empty-state overlay fills the transcript pane only", () => {
  assert.match(css, /\.empty-state\s*\{[^}]*inset:\s*0;/s);
  assert.doesNotMatch(css, /inset:\s*0\s+0\s+118px/);
});
