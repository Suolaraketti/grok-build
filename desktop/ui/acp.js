// ACP (Agent Client Protocol) client over the Tauri transport.
//
// The Rust backend spawns `grok agent stdio` and forwards newline-delimited
// JSON-RPC both ways: we call `send_to_agent` to write, and receive every
// agent stdout line via the `acp:line` event. This module owns request ids,
// pending-response bookkeeping, dispatch of agent-initiated requests, and the
// xAI auth extension methods (`x.ai/auth/*`).

"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Auth method ids advertised by the agent (see xai-grok-shell auth_method.rs).
export const METHOD = {
  API_KEY: "xai.api_key",
  CACHED_TOKEN: "cached_token",
  GROK_COM: "grok.com",
  OIDC: "oidc",
};

export class AgentClient {
  constructor() {
    this.generation = 0;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.initializeResult = null;
    this.authMethods = [];
    this.binaryPath = null;

    // App-provided handlers.
    this.onSessionUpdate = () => {};
    this.onSessionNotification = () => {}; // x.ai/session_notification (retries, compaction, ...)
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

  // Spawn (or respawn) the agent and run the ACP initialize handshake.
  async start({ model = null, alwaysApprove = false } = {}) {
    await this._setupListeners();
    this._failAllPending("agent restarted");

    const info = await invoke("start_agent", { model, alwaysApprove });
    this.generation = info.generation;
    this.binaryPath = info.binary;

    this.initializeResult = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "grok-build-desktop", version: "1.0.0" },
    });
    this.authMethods = this.initializeResult.authMethods || [];
    return this.initializeResult;
  }

  async stop() {
    this._failAllPending("agent stopped");
    await invoke("stop_agent");
  }

  hasAuthMethod(id) {
    return this.authMethods.some((m) => m.id === id);
  }

  // The interactive (browser) login method the agent advertises, if any.
  interactiveMethod() {
    return this.authMethods.find((m) => m.id === METHOD.GROK_COM || m.id === METHOD.OIDC) || null;
  }

  // ---- ACP core ----

  async newSession(cwd) {
    return await this.request("session/new", { cwd, mcpServers: [] });
  }

  // Restore a stored session for continuation. The agent replays the whole
  // transcript as session/update notifications BEFORE this resolves, so the
  // caller must be ready to route updates for this sessionId when calling.
  async loadSession(sessionId, cwd) {
    return await this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId, text) {
    return await this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId) {
    this._send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async setModel(sessionId, modelId) {
    return await this.request("session/set_model", { sessionId, modelId });
  }

  // Slash commands advertised by the agent (initialize._meta.availableCommands,
  // refreshed by available_commands_update session updates).
  availableCommands() {
    return this.initializeResult?._meta?.availableCommands || [];
  }

  // Fire the ACP `authenticate` request. Returns the promise WITHOUT awaiting
  // here so the caller can poll the auth URL concurrently (the request blocks
  // until the whole login flow finishes).
  authenticate(methodId, meta = {}) {
    return this.request("authenticate", { methodId, _meta: meta });
  }

  // ---- xAI auth extension (x.ai/auth/*) ----
  //
  // ACP extension methods travel as a JSON-RPC method equal to the extension
  // name prefixed with "_", with the params passed directly. Handlers that use
  // `to_raw_response` (auth/info, get_url, submit_code) put the payload object
  // straight in `result`; a few (setApiKey/getApiKey) double-wrap it under
  // `result.result`, which `_unwrapExt` flattens.

  async ext(method, params = {}) {
    const result = await this.request(`_${method}`, params);
    return this._unwrapExt(result);
  }

  _unwrapExt(result) {
    if (result == null) return {};
    // Flatten the ExtMethodResult `{ result: <payload> }` envelope when present.
    if (
      typeof result === "object" &&
      result.result !== undefined &&
      Object.keys(result).length === 1
    ) {
      return result.result ?? {};
    }
    return result;
  }

  authInfo() { return this.ext("x.ai/auth/info"); }
  getAuthUrl() { return this.ext("x.ai/auth/get_url"); }
  submitAuthCode(code) { return this.ext("x.ai/auth/submit_code", { code }); }
  setApiKey(key) { return this.ext("x.ai/setApiKey", { key }); }
  logout(scope) { return this.ext("x.ai/auth/logout", { scope: scope ?? null }); }
  billing() { return this.ext("x.ai/billing", {}); }

  // ---- transport ----

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
    for (const { reject } of this.pending.values()) reject(new Error(reason));
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
    } else if (
      msg.method === "_x.ai/session_notification" ||
      msg.method === "x.ai/session_notification"
    ) {
      // Session-level side channel: retry/backoff state, auto-compaction, etc.
      this.onSessionNotification(msg.params);
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

// ---- Tauri command wrappers ----

export async function agentBinaryInfo() { return await invoke("agent_binary_info"); }
export async function pickFolder() { return await invoke("pick_folder"); }
export async function homeDir() { return await invoke("home_dir"); }
export async function listStoredSessions(limit) { return await invoke("list_sessions", { limit }); }
export async function openExternal(url) { return await invoke("open_external", { url }); }
