# Grok Build Desktop

A downloadable desktop app for [Grok Build](../README.md) — a chat-style GUI
(in the spirit of the ChatGPT / Codex desktop apps) instead of the terminal
TUI. Sign in with your Grok account, pick a project folder, chat with the
agent, watch it think, see every tool call it makes, and approve or deny
actions from a dialog.

## Signing in

The app signs you in **without ever touching a terminal**, using the agent's
`x.ai/auth/*` ACP extension:

- **Sign in with Grok** — opens your browser for the standard xAI OAuth
  (loopback) flow. Approve in the browser and the app completes automatically;
  a paste-code fallback covers browsers that can't redirect back.
- **Use an API key** — paste an `xai-…` key from
  [console.x.ai](https://console.x.ai) instead.
- **Already signed in** — if you've logged in before (here or via the `grok`
  CLI), or `XAI_API_KEY` is set, the app authenticates silently on launch and
  drops you straight into a chat.

Credentials live in `~/.grok`, shared with the CLI. Sign out from the account
menu in the sidebar.

## How it works

The app does **not** reimplement the agent. It is a thin
[Tauri 2](https://tauri.app) shell around the same agent runtime the CLI
uses, talking to it over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP):

```
+--------------------------------------------+
|   Grok Build Desktop (Tauri window)        |
|                                            |
|   ui/  — chat frontend (HTML/JS, no deps)  |
|     | JSON-RPC lines via Tauri events      |
|   src-tauri/ — spawns + pipes the agent    |
+-------------------|------------------------+
                    | stdio
+-------------------v------------------------+
|   grok agent stdio   (ACP JSON-RPC server) |
+--------------------------------------------+
```

- **`src-tauri/`** — Rust backend. Spawns `grok agent stdio`, forwards
  JSON-RPC lines both ways (`acp:line` events in, `send_to_agent` command
  out), and exposes small helpers (folder picker, open-in-browser).
- **`ui/`** — plain HTML/CSS/JS frontend, no framework and no npm build
  step. `acp.js` is the ACP client (requests, streamed `session/update`
  notifications, permission requests), `main.js` is the app, `markdown.js`
  renders agent output.

Each chat in the sidebar is its own ACP session (`session/new`) against the
selected project folder, so one agent process serves many chats.

## Finding the agent binary

At startup the app looks for the agent in this order:

1. `GROK_DESKTOP_AGENT_BIN` environment variable (path to a binary)
2. A bundled binary in the app's resources (`resources/bin/grok`) — release
   installers built by CI ship this, making the app self-contained
3. `grok` or `xai-grok-pager` on `PATH`

Authentication is shared with the CLI (`~/.grok`): if you're already logged
in via `grok login` — or have `XAI_API_KEY` set — the desktop app just works.

## Developing

Requirements are the same as the repo root (Rust; Linux additionally needs
webkit2gtk and GTK dev packages: `libwebkit2gtk-4.1-dev libgtk-3-dev
librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`).

```sh
cd desktop/src-tauri
cargo run                    # debug build, uses grok from PATH
cargo build --release        # release binary
```

There is no frontend build step — edit `ui/*` and rerun. If you have the
Tauri CLI (`npm i -g @tauri-apps/cli`), `tauri dev` gives hot reload.

To point the app at a locally built agent:

```sh
cargo build --release -p xai-grok-pager-bin        # from the repo root
GROK_DESKTOP_AGENT_BIN=$PWD/target/release/xai-grok-pager \
  cargo run --manifest-path desktop/src-tauri/Cargo.toml
```

This crate is intentionally **not** part of the repository's generated root
workspace (the root `Cargo.toml` is machine-generated); it builds standalone
from `desktop/src-tauri`.

## Building installers

CI (`.github/workflows/desktop.yml`) builds downloadable bundles on demand
and on `desktop-v*` tags:

| Platform | Bundles |
|----------|---------|
| macOS (Apple Silicon + Intel) | `.dmg` |
| Windows | `.msi`, NSIS `.exe` |
| Linux | `.deb`, `.rpm`, `.AppImage` |

Each bundle ships the agent binary built from this repository.

### Installing a downloaded build

Grab the installer for your platform from the
[Releases page](https://github.com/Suolaraketti/grok-build/releases):

| Platform | File | First launch |
|----------|------|--------------|
| macOS | `.dmg` | If the build is unsigned: right-click the app → **Open** → **Open** (only needed once). Signed/notarized builds open normally. |
| Windows | `.msi` or setup `.exe` | If SmartScreen appears: **More info** → **Run anyway** (unsigned builds only). |
| Linux (Debian/Ubuntu) | `.deb` | `sudo apt install ./Grok.Build_*.deb` |
| Linux (Fedora) | `.rpm` | `sudo dnf install ./Grok.Build-*.rpm` |
| Linux (any) | `.AppImage` | `chmod +x`, then run it. |

The app signs you in with your Grok account on first launch (or an xAI API
key). No terminal, no other installs — the agent is bundled inside.

### Code signing (maintainers)

The workflow signs and notarizes macOS builds automatically **when Apple
credentials are configured as repository secrets** — with them set, Mac users
get no Gatekeeper prompt at all. Without them, builds are produced unsigned.

With an Apple Developer account:

1. In Xcode (Settings → Accounts → Manage Certificates) or at
   [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates),
   create a **Developer ID Application** certificate.
2. Export it from Keychain Access as a `.p12` with a password, then base64 it:
   `base64 -i certificate.p12 | pbcopy`
3. Create an **app-specific password** for your Apple ID at
   [appleid.apple.com](https://appleid.apple.com) (Sign-In & Security →
   App-Specific Passwords) — used for notarization.
4. Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `APPLE_CERTIFICATE` | base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your 10-character team ID |

The next tagged build is then signed and notarized. Windows signing is
separate (a Microsoft-trusted certificate, e.g. Azure Trusted Signing) and
not configured yet — Windows builds show SmartScreen until it is.

To build locally instead:

```sh
cargo build --release -p xai-grok-pager-bin
cp target/release/xai-grok-pager desktop/src-tauri/resources/bin/grok
npm i -g @tauri-apps/cli && cd desktop/src-tauri && tauri build
```

Bundles land in `desktop/src-tauri/target/release/bundle/`.

> **Note:** CI bundles are unsigned. On macOS, first launch requires
> right-click → Open (or `xattr -dr com.apple.quarantine "Grok Build.app"`);
> on Windows, SmartScreen will ask to confirm.
