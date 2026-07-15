//! Grok Build Desktop backend.
//!
//! The webview owns the ACP (Agent Client Protocol) conversation; this
//! backend is a thin transport. It spawns `grok agent stdio`, forwards
//! newline-delimited JSON-RPC from the webview to the child's stdin, and
//! emits every stdout line back to the webview as an `acp:line` event.
//!
//! Events emitted to the webview (all payloads carry the spawn `generation`
//! so the frontend can discard lines from a previous agent process):
//!   - `acp:line`   { generation, line }   one JSON-RPC message from the agent
//!   - `acp:stderr` { generation, line }   agent diagnostics
//!   - `acp:exit`   { generation }         agent stdout reached EOF

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const AGENT_BIN_ENV: &str = "GROK_DESKTOP_AGENT_BIN";

struct RunningAgent {
    child: Child,
    stdin: ChildStdin,
    generation: u64,
}

#[derive(Default)]
struct AgentState {
    running: Mutex<Option<RunningAgent>>,
    next_generation: Mutex<u64>,
}

#[derive(Serialize, Clone)]
struct LineEvent {
    generation: u64,
    line: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    generation: u64,
}

#[derive(Serialize)]
struct AgentInfo {
    binary: Option<String>,
    generation: u64,
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Locate the agent binary. Order: explicit env override, a binary bundled
/// into the app's resource dir, then `grok` / `xai-grok-pager` on PATH.
fn resolve_agent_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var(AGENT_BIN_ENV) {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        for name in ["grok", "xai-grok-pager"] {
            let p = resource_dir.join("resources/bin").join(exe_name(name));
            if p.is_file() {
                return Some(p);
            }
        }
    }

    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in ["grok", "xai-grok-pager"] {
            let p = dir.join(exe_name(name));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn kill_running(state: &AgentState) {
    if let Some(mut agent) = state.running.lock().unwrap().take() {
        let _ = agent.child.kill();
        let _ = agent.child.wait();
    }
}

/// Spawn `grok agent stdio` and start pumping its stdout/stderr to the
/// webview. Replaces any previously running agent process.
#[tauri::command]
fn start_agent(
    app: AppHandle,
    state: State<'_, AgentState>,
    model: Option<String>,
    always_approve: Option<bool>,
) -> Result<AgentInfo, String> {
    let binary = resolve_agent_binary(&app).ok_or_else(|| {
        format!(
            "Could not find the `grok` agent binary. Install the Grok CLI \
             (https://x.ai/cli), or point {AGENT_BIN_ENV} at a build of \
             xai-grok-pager."
        )
    })?;

    kill_running(&state);

    let generation = {
        let mut next = state.next_generation.lock().unwrap();
        *next += 1;
        *next
    };

    let mut cmd = Command::new(&binary);
    cmd.arg("agent");
    if let Some(model) = model.as_deref().filter(|m| !m.trim().is_empty()) {
        cmd.args(["--model", model.trim()]);
    }
    if always_approve == Some(true) {
        cmd.arg("--always-approve");
    }
    cmd.arg("stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start {}: {e}", binary.display()))?;

    let stdin = child.stdin.take().ok_or("agent stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("agent stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("agent stderr unavailable")?;

    let out_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    let _ = out_app.emit("acp:line", LineEvent { generation, line });
                }
                Err(_) => break,
            }
        }
        let _ = out_app.emit("acp:exit", ExitEvent { generation });
    });

    let err_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = err_app.emit("acp:stderr", LineEvent { generation, line });
        }
    });

    *state.running.lock().unwrap() = Some(RunningAgent {
        child,
        stdin,
        generation,
    });

    Ok(AgentInfo {
        binary: Some(binary.display().to_string()),
        generation,
    })
}

/// Write one JSON-RPC message (a single line, no trailing newline needed)
/// to the agent's stdin.
#[tauri::command]
fn send_to_agent(state: State<'_, AgentState>, message: String) -> Result<(), String> {
    let mut guard = state.running.lock().unwrap();
    let agent = guard.as_mut().ok_or("agent is not running")?;
    agent
        .stdin
        .write_all(message.as_bytes())
        .and_then(|_| agent.stdin.write_all(b"\n"))
        .and_then(|_| agent.stdin.flush())
        .map_err(|e| format!("failed to write to agent: {e}"))
}

#[tauri::command]
fn stop_agent(state: State<'_, AgentState>) {
    kill_running(&state);
}

/// Which agent binary a `start_agent` call would use, without starting it.
#[tauri::command]
fn agent_binary_info(app: AppHandle, state: State<'_, AgentState>) -> AgentInfo {
    let generation = state
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.generation)
        .unwrap_or(0);
    AgentInfo {
        binary: resolve_agent_binary(&app).map(|p| p.display().to_string()),
        generation,
    }
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
fn home_dir(app: AppHandle) -> Option<String> {
    app.path().home_dir().ok().map(|p| p.display().to_string())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) URLs can be opened".into());
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AgentState::default())
        .invoke_handler(tauri::generate_handler![
            start_agent,
            send_to_agent,
            stop_agent,
            agent_binary_info,
            pick_folder,
            home_dir,
            open_external,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                kill_running(&window.state::<AgentState>());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Grok Build Desktop");
}
