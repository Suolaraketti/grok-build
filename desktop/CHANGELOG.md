# Desktop changelog

## 1.4.0 — 2026-08-17

Marketplace tab in Extensions: add/remove sources, filter plugins, install,
update, and uninstall through the same `x.ai/marketplace/*` ACP the TUI uses.

## 1.3.0 — 2026-08-17

Extensions studio (skills, MCP, plugins, hooks) and inspector rail (session
info, context, running subagents, worktrees, plan/goal). System/dark/light
theme. Docs chip.

## 1.2.0 — 2026-08-17

Official grok **1.0.5** crate sync. Image/file attach, mid-turn steer, prompt
history, reasoning effort, rewind, compact, fork, rename/delete, export, auto
permission mode, Ctrl+K palette. Identifies to the API as `grok-pager` so
sampling does not waitlist the unreleased official desktop product.

## 1.1.2 — 2026-08-17

Stop sending `clientIdentifier: grok-desktop` (403 “coming soon”). Keep
`clientType: grok_desktop` for folder-trust / plan / questions. Surface real
API errors instead of JSON-RPC “Internal error”.

## 1.1.1 — 2026-08-16

Restore sending chats: empty-state no longer covers the composer; Send starts
a session; JSON-RPC ids coerce; desktop reverse-requests are answered.

## 1.1.0

Conversation surface: stream quality, Ask/Agent/Plan modes, permissions.
