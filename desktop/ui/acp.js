// Minimal ACP (Agent Client Protocol) client over the Tauri transport.
//
// The Rust backend spawns `grok agent stdio` and forwards newline-delimited
// JSON-RPC both ways: we call the `send_to_agent` command to write, and
// receive every agent stdout line via the `acp:line` event. This module owns
// request ids, pending-response bookkeeping, and dispatch of agent-initiated
// requests/notifications to app-provided handlers.

"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export class AgentClient {
  constructor() {
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.initializeResult = null;
    this.binaryPath = null;

    // App-provided handlers.
    this.onSessionUpdate = () => {};
    this.onPermissionRequest = async () => ({ outcome: "cancelled" });
    this.onExit = () => {};
    this.onStderr = () => {};

    this._unlisteners = [];
  }

  async _setupListeners() {
    if (this._unlisteners.length) return;
    this._unlisteners.push(
      await listen("acp:line", (e) => {
        if (e.payload.generation !== this.generation) return;
        this._handleLine(e.payload.line);
      }),
      await listen("acp:stderr", (e) => {
        if (e.payload.generation !== this.generation) return;
        this.onStderr(e.payload.line);
      }),
      await listen("acp:exit", (e) => {
        if (e.payload.generation !== this.generation) return;
        this._failAllPending("agent process exited");
        this.onExit();
      })
    );
  }

  // Spawn (or respawn) the agent process and run the ACP initialize
  // handshake. Returns the initialize result.
  async start({ model = null, alwaysApprove = false } = {}) {
    await this._setupListeners();
    this._failAllPending("agent restarted");

    const info = await invoke("start_agent", { model, alwaysApprove });
    this.generation = info.generation;
    this.binaryPath = info.binary;

    this.initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        // The agent uses its own filesystem/terminal implementations; this
        // client intentionally advertises none so it never has to answer
        // fs/terminal callbacks.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "grok-build-desktop", version: "0.1.0" },
    });
    return this.initializeResult;
  }

  async stop() {
    this._failAllPending("agent stopped");
    await invoke("stop_agent");
  }

  async newSession(cwd) {
    return await this.request("session/new", { cwd, mcpServers: [] });
  }

  // Send a user prompt; streamed content arrives via onSessionUpdate.
  // Resolves with { stopReason } when the turn ends.
  async prompt(sessionId, text) {
    return await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId) {
    this._send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this._send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  _send(msg) {
    invoke("send_to_agent", { message: JSON.stringify(msg) }).catch((err) => {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(new Error(String(err)));
      }
    });
  }

  _failAllPending(reason) {
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout
    }

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || "agent error");
        err.code = msg.error.code;
        err.data = msg.error.data;
        p.reject(err);
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }

    // Agent-initiated request that expects a reply.
    if (msg.id !== undefined && msg.method !== undefined) {
      this._handleAgentRequest(msg);
      return;
    }

    // Notification.
    if (msg.method === "session/update" || msg.method === "x.ai/session/update") {
      this.onSessionUpdate(msg.params);
    }
  }

  async _handleAgentRequest(msg) {
    let result = null;
    let error = null;
    try {
      if (msg.method === "session/request_permission") {
        result = { outcome: await this.onPermissionRequest(msg.params) };
      } else {
        error = { code: -32601, message: `method not supported: ${msg.method}` };
      }
    } catch (e) {
      error = { code: -32603, message: String(e && e.message ? e.message : e) };
    }
    const reply = { jsonrpc: "2.0", id: msg.id };
    if (error) reply.error = error;
    else reply.result = result;
    this._send(reply);
  }
}

export async function agentBinaryInfo() {
  return await invoke("agent_binary_info");
}

export async function pickFolder() {
  return await invoke("pick_folder");
}

export async function homeDir() {
  return await invoke("home_dir");
}

export async function openExternal(url) {
  return await invoke("open_external", { url });
}
