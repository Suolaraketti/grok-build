# Bundled agent binary

Release builds place the `grok` agent binary (built from
`crates/codegen/xai-grok-pager-bin` in this repository, artifact name
`xai-grok-pager`) into this directory as `grok` (or `grok.exe` on Windows)
before running `tauri build`, so installers ship a self-contained app.

When no binary is bundled here, the desktop app falls back to `grok` /
`xai-grok-pager` found on `PATH`, or the path in the
`GROK_DESKTOP_AGENT_BIN` environment variable.
