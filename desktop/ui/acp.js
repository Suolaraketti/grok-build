// ACP (Agent Client Protocol) client over the Tauri transport.
//
// The Rust backend spawns `grok agent stdio` and forwards newline-delimited
// JSON-RPC both ways: we call `send_to_agent` to write, and receive every
// agent stdout line via the `acp:line` event. This module owns request ids,
// pending-response bookkeeping, dispatch of agent-initiated requests, and the
// xAI auth extension methods (`x.ai/auth/*`).

"use strict";

import {
  rpcIdKey,
  rpcErrorText,
  unwrapAgentRequest,
  isPermissionMethod,
  isFolderTrustMethod,
  isExitPlanMethod,
  isAskUserQuestionMethod,
  DESKTOP_VERSION,
  CLIENT_INFO_NAME,
  CLIENT_TYPE,
  CLIENT_IDENTIFIER,
  unwrapExtResult,
} from "./protocol.js";

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
    this.onFolderTrustRequest = async () => ({ outcome: "trust" });
    this.onExitPlanMode = async () => ({ outcome: "cancelled" });
    this.onAskUserQuestion = async () => ({ outcome: "cancelled" });
    this.onYoloModeChanged = () => {};
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
      clientInfo: { name: CLIENT_INFO_NAME, version: DESKTOP_VERSION },
      _meta: {
        // Desktop permission UX (folder trust, plan, ask-user-question).
        clientType: CLIENT_TYPE,
        // Sampling User-Agent must be the shipping CLI product, not the
        // waitlisted official grok-desktop app (403 "coming soon").
        clientIdentifier: CLIENT_IDENTIFIER,
        clientVersion: DESKTOP_VERSION,
      },
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

  async newSession(cwd, meta = {}) {
    return await this.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: this._sessionMeta(meta),
    });
  }

  // Restore a stored session for continuation. The agent replays the whole
  // transcript as session/update notifications BEFORE this resolves, so the
  // caller must be ready to route updates for this sessionId when calling.
  async loadSession(sessionId, cwd, meta = {}) {
    const params = { sessionId, cwd, mcpServers: [] };
    const cleaned = this._sessionMeta(meta);
    if (Object.keys(cleaned).length) params._meta = cleaned;
    return await this.request("session/load", params);
  }

  // Official Aug 4: first-class resume. Fall back to session/load on older agents.
  async resumeSession(sessionId, cwd, meta = {}) {
    const params = { sessionId, cwd, mcpServers: [] };
    const cleaned = this._sessionMeta(meta);
    if (Object.keys(cleaned).length) params._meta = cleaned;
    try {
      return await this.request("session/resume", params);
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/method not found|unknown|not supported|invalid/i.test(msg)) {
        return await this.loadSession(sessionId, cwd, meta);
      }
      throw err;
    }
  }

  // `blocks` is an optional ACP ContentBlock[] (text + image). When omitted
  // we send a single text block, matching 1.1.x.
  async prompt(sessionId, text, meta = {}, blocks = null) {
    const prompt = Array.isArray(blocks) && blocks.length
      ? blocks
      : [{ type: "text", text }];
    const params = { sessionId, prompt };
    const cleaned = this._promptMeta(meta);
    if (Object.keys(cleaned).length) params._meta = cleaned;
    return await this.request("session/prompt", params);
  }

  cancel(sessionId) {
    this._send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async setModel(sessionId, modelId, effort = "") {
    const params = { sessionId, modelId };
    if (effort) params._meta = { reasoningEffort: effort };
    return await this.request("session/set_model", params);
  }

  async setMode(sessionId, modeId) {
    return await this.request("session/set_mode", { sessionId, modeId });
  }

  // Notification (no response). The shell flips session yolo/auto flags.
  yoloModeChanged({ yoloMode, autoMode, permissionMode } = {}) {
    const params = { clientIdentifier: CLIENT_IDENTIFIER };
    if (yoloMode !== undefined) params.yolo_mode = !!yoloMode;
    if (autoMode !== undefined) params.auto_mode = !!autoMode;
    if (permissionMode) params.permission_mode = permissionMode;
    this._send({ jsonrpc: "2.0", method: "_x.ai/yolo_mode_changed", params });
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
    return unwrapExtResult(result);
  }

  authInfo() { return this.ext("x.ai/auth/info"); }
  getAuthUrl() { return this.ext("x.ai/auth/get_url"); }
  submitAuthCode(code) { return this.ext("x.ai/auth/submit_code", { code }); }
  setApiKey(key) { return this.ext("x.ai/setApiKey", { key }); }
  logout(scope) { return this.ext("x.ai/auth/logout", { scope: scope ?? null }); }
  billing() { return this.ext("x.ai/billing", {}); }

  renameSession(sessionId, title, cwd) {
    return this.ext("x.ai/session/rename", { sessionId, title, cwd: cwd || undefined });
  }
  deleteSession(sessionId, cwd) {
    return this.ext("x.ai/session/delete", { sessionId, cwd: cwd || undefined });
  }
  forkSession(sourceSessionId, sourceCwd, newCwd) {
    return this.ext("x.ai/session/fork", {
      sourceSessionId,
      sourceCwd,
      newCwd: newCwd || sourceCwd,
    });
  }
  sessionUsage(sessionId) {
    return this.ext("x.ai/session/usage", { sessionId });
  }
  rewindPoints(sessionId) {
    return this.ext("x.ai/rewind/points", { sessionId });
  }
  rewindTo(sessionId, targetPromptIndex, { force = false } = {}) {
    return this.ext("x.ai/rewind/execute", { sessionId, targetPromptIndex, force });
  }
  compactConversation(sessionId, userContext) {
    return this.ext("x.ai/compact_conversation", {
      sessionId,
      userContext: userContext || undefined,
    });
  }
  interject(sessionId, text, content) {
    const params = { sessionId, text };
    if (content) params.content = content;
    return this.ext("x.ai/interject", params);
  }
  btw(sessionId, question) {
    return this.ext("x.ai/btw", { sessionId, question });
  }
  promptHistory(cwd, filterSessionId) {
    return this.ext("x.ai/prompt_history", {
      cwd,
      filter_session_id: filterSessionId || undefined,
    });
  }
  memoryFlush(sessionId) {
    return this.ext("x.ai/memory/flush", { session_id: sessionId });
  }
  listCommands(sessionId) {
    return this.ext("x.ai/commands/list", sessionId ? { sessionId } : {});
  }
  setPrivacyRetention(optOut) {
    return this.ext("x.ai/privacy/setCodingDataRetention", {
      codingDataRetentionOptOut: !!optOut,
    });
  }
  listSkills(cwd) {
    return this.ext("x.ai/skills/list", { cwd: cwd || undefined });
  }
  listPlugins(sessionId) {
    return this.ext("x.ai/plugins/list", { sessionId: sessionId || undefined });
  }
  listHooks(sessionId) {
    return this.ext("x.ai/hooks/list", { sessionId: sessionId || undefined });
  }
  listWorkflows(sessionId) {
    return this.ext("x.ai/workflows/list", { sessionId: sessionId || undefined });
  }
  listMcp(sessionId) {
    return this.ext("x.ai/mcp/list", { sessionId: sessionId || undefined });
  }
  toggleMcp(sessionId, serverName, enabled) {
    return this.ext("x.ai/mcp/toggle", {
      session_id: sessionId,
      server_name: serverName,
      enabled: !!enabled,
    });
  }
  sessionInfo(sessionId) {
    return this.ext("x.ai/session/info", { sessionId });
  }
  sessionState(sessionId, cwd) {
    return this.ext("x.ai/session/state", { sessionId, cwd });
  }
  listSubagents(sessionId) {
    return this.ext("x.ai/subagent/list_running", { sessionId });
  }
  cancelSubagent(subagentId) {
    return this.ext("x.ai/subagent/cancel", { subagentId });
  }
  listWorktrees() {
    return this.ext("x.ai/git/worktree/list", { include_all: true });
  }
  toggleSkill(name, enabled, cwd) {
    return this.ext("x.ai/skills/toggle", { name, enabled: !!enabled, cwd: cwd || undefined });
  }
  pluginAction(sessionId, action) {
    return this.ext("x.ai/plugins/action", { sessionId, action });
  }
  hookAction(sessionId, action) {
    return this.ext("x.ai/hooks/action", { sessionId, action });
  }
  marketplaceList() {
    return this.ext("x.ai/marketplace/list", {});
  }
  marketplaceAction(sessionId, action) {
    return this.ext("x.ai/marketplace/action", { sessionId, action });
  }

  _sessionMeta(meta = {}) {
    const out = { ...meta };
    if (meta.reasoningEffort) out.reasoningEffort = meta.reasoningEffort;
    return out;
  }

  _promptMeta(meta = {}) {
    const cleaned = {};
    if (meta && typeof meta === "object") {
      if (meta.mode && meta.mode !== "default") cleaned.mode = meta.mode;
      if (meta.promptId) cleaned.promptId = meta.promptId;
    }
    return cleaned;
  }

  // ---- transport ----

  request(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(rpcIdKey(id), { resolve, reject });
    });
    this._send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  _send(msg) {
    invoke("send_to_agent", { message: JSON.stringify(msg) }).catch((err) => {
      const key = rpcIdKey(msg.id);
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
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

    // Response to one of our requests. Coerce id so number 1 and "1" match.
    if (msg.id !== undefined && msg.method === undefined) {
      const key = rpcIdKey(msg.id);
      const p = this.pending.get(key);
      if (!p) return;
      this.pending.delete(key);
      if (msg.error) {
        const err = new Error(
          rpcErrorText({ message: msg.error.message, data: msg.error.data }) || "agent error"
        );
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
    } else if (
      msg.method === "_x.ai/yolo_mode_changed" ||
      msg.method === "x.ai/yolo_mode_changed"
    ) {
      this.onYoloModeChanged(msg.params || {});
    }
  }

  async _handleAgentRequest(msg) {
    const { method, params } = unwrapAgentRequest(msg);
    let result = null;
    let error = null;
    try {
      if (isPermissionMethod(method)) {
        result = { outcome: await this.onPermissionRequest(params) };
      } else if (isFolderTrustMethod(method)) {
        result = await this.onFolderTrustRequest(params);
      } else if (isExitPlanMethod(method)) {
        result = await this.onExitPlanMode(params);
      } else if (isAskUserQuestionMethod(method)) {
        result = await this.onAskUserQuestion(params);
      } else {
        error = { code: -32601, message: `method not supported: ${method}` };
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
