# AGENTS.md

## Cursor Cloud specific instructions

This repository is **Grok Build** (`grok`): SpaceXAI's terminal AI coding agent,
a large Rust workspace (~80 crates under `crates/`). The primary product is the
`grok` CLI/TUI/agent binary (crate `xai-grok-pager-bin`, artifact
`xai-grok-pager`). `desktop/` is an optional Tauri GUI over the same agent
runtime.

Standard build/lint/test/run commands are documented in `README.md` (root) and
`desktop/README.md` — use those. Notes below are only the non-obvious things.

### Build toolchain gotchas
- The Rust toolchain is pinned by `rust-toolchain.toml` (currently 1.92.0) and
  is installed automatically by `rustup` on first build.
- **`protoc` is required to build** — crate `xai-grok-tools-api`'s `build.rs`
  compiles protobufs. The repo's `bin/protoc` is a `dotslash` launcher, but
  `dotslash` is not installed here; the build falls back to a `protoc` on
  `PATH`. A matching `protoc` (v29.3) is installed system-wide at
  `/usr/local/bin/protoc`. If a build fails with a protoc/prost error, confirm
  `protoc --version` works.
- The root `Cargo.toml` is machine-generated — treat it as read-only; edit
  per-crate `Cargo.toml` files instead.
- Full-workspace builds are slow (~5 min cold). Prefer per-crate targets
  (`cargo check -p <crate>`, `cargo test -p <crate>`).

### Tests
- Automated tests use an in-process `MockInferenceServer` (crate
  `xai-grok-test-support`) and do **not** need xAI credentials or network.
- The built-binary end-to-end tests in
  `crates/codegen/xai-grok-shell/tests/test_built_binary_e2e.rs` are
  `#[ignore]`d and drive the real `grok` binary. Run them with `--ignored` and
  set `GROK_BINARY` to a prebuilt binary to avoid an implicit rebuild:
  `GROK_BINARY=/workspace/target/debug/xai-grok-pager cargo test -p xai-grok-shell --test test_built_binary_e2e -- --ignored`.
- `cargo fmt --all -- --check` reports pre-existing whitespace diffs in this
  synced tree (formatting is not enforced here) — that is expected, not
  something your change introduced.

### Running the product
- Real end-to-end usage against live AI requires authentication (`XAI_API_KEY`
  or interactive `grok login` OAuth) and network egress to xAI
  (`cli-chat-proxy.grok.com`, `auth.x.ai`). These are not configured by default
  in the cloud environment, so the offline way to exercise core functionality
  is the mock-backed test suite above.

### Desktop (optional)
- `desktop/src-tauri` builds standalone (it is intentionally NOT part of the
  root workspace): `cd desktop/src-tauri && cargo build`.
- Linux GUI build needs GTK/WebKit dev libs
  (`libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev`) — already installed in this environment.
  Running the GUI additionally needs a display and xAI auth; point it at a local
  agent with `GROK_DESKTOP_AGENT_BIN`.
