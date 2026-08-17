// Grok Build Desktop — app wiring.
//
// Screens: boot → signin → authing → app. One agent process serves the whole
// app; each chat is an ACP session (`session/new`) inside it. Auth uses the
// agent's `x.ai/auth/*` extension so users sign in with their Grok account
// (browser OAuth) or an API key, without ever touching a terminal.

"use strict";

import { AgentClient, METHOD, agentBinaryInfo, pickFolder, homeDir, listStoredSessions, openExternal } from "./acp.js";
import { createMdStream, updateMdStream } from "./markdown.js";
import { unifiedLineDiff } from "./diff.js";
import { friendlyRpcError } from "./protocol.js";

const $ = (id) => document.getElementById(id);
const client = new AgentClient();

const prefs = {
  get folder() { return localStorage.getItem("grok.folder") || ""; },
  set folder(v) { v ? localStorage.setItem("grok.folder", v) : localStorage.removeItem("grok.folder"); },
  get model() { return localStorage.getItem("grok.model") || ""; },
  set model(v) { v ? localStorage.setItem("grok.model", v) : localStorage.removeItem("grok.model"); },
  get alwaysApprove() { return localStorage.getItem("grok.alwaysApprove") === "1"; },
  set alwaysApprove(v) { localStorage.setItem("grok.alwaysApprove", v ? "1" : "0"); },
  get mode() { return localStorage.getItem("grok.mode") || "default"; },
  set mode(v) {
    const id = v === "ask" || v === "plan" ? v : "default";
    localStorage.setItem("grok.mode", id);
  },
};

const state = {
  folder: "", // set from prefs at enterApp; NEVER defaults to the home dir
  homeDir: "",
  account: null,
  chats: [],
  activeChat: null,
  stderrTail: [],
  authSeq: 0,
  commands: [], // slash commands advertised by the agent
  billing: null, // {at, data|error}
  stored: [], // past sessions from ~/.grok/sessions (via list_sessions)
  restarting: false,
};

const SUGGESTIONS = [
  "Explain this codebase to me",
  "Find and fix a bug",
  "Add tests for the current changes",
  "Write a README",
];

function show(screen) {
  for (const id of ["boot", "signin", "authing", "app"]) {
    $(id).classList.toggle("hidden", id !== screen);
  }
}

function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

// ============================ BOOT / STARTUP ============================

async function boot() {
  show("boot");
  $("boot-text").textContent = "Starting Grok Build…";

  const info = await agentBinaryInfo();
  if (!info.binary) {
    show("signin");
    signinError(
      "The grok agent binary wasn't found. Install the Grok CLI from x.ai/cli " +
        "(or set GROK_DESKTOP_AGENT_BIN), then reopen the app."
    );
    $("signin-oauth").disabled = true;
    return;
  }

  try {
    await client.start({ model: prefs.model || null, alwaysApprove: prefs.alwaysApprove });
  } catch (err) {
    show("signin");
    signinError(`Couldn't start the agent: ${err.message || err}`);
    return;
  }

  state.commands = client.availableCommands();

  // Already authenticated? cached_token / xai.api_key are only advertised when
  // valid credentials exist, so activating them never opens a browser.
  if (hasSilentAuth()) {
    $("boot-text").textContent = "Signing you in…";
    try {
      await silentAuth();
      await enterApp();
      return;
    } catch {
      // fall through to the sign-in screen
    }
  }

  presentSignin();
}

function silentAuthMethod() {
  if (client.hasAuthMethod(METHOD.CACHED_TOKEN)) return METHOD.CACHED_TOKEN;
  if (client.hasAuthMethod(METHOD.API_KEY)) return METHOD.API_KEY;
  return null;
}

function hasSilentAuth() {
  return !!silentAuthMethod();
}

async function silentAuth() {
  const method = silentAuthMethod();
  if (!method) throw new Error("No silent auth method available");
  await client.authenticate(method, {});
}

function presentSignin() {
  show("signin");
  const method = client.interactiveMethod();
  if (method) {
    $("signin-oauth-label").textContent = method.name
      ? `Sign in with ${method.name}`
      : "Sign in with Grok";
    $("signin-oauth").disabled = false;
  } else {
    $("signin-oauth").classList.add("hidden");
    $("apikey-panel").classList.remove("hidden");
    $("signin-apikey-toggle").classList.add("hidden");
  }
}

function signinError(msg) {
  const el = $("signin-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

// ============================ SIGN IN ============================

$("signin-oauth").addEventListener("click", startOAuthLogin);

$("signin-apikey-toggle").addEventListener("click", () => {
  $("apikey-panel").classList.toggle("hidden");
  $("apikey-input").focus();
});

$("signin-apikey-submit").addEventListener("click", submitApiKey);
$("apikey-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitApiKey();
});

async function submitApiKey() {
  const key = $("apikey-input").value.trim();
  if (!key) return;
  signinError("");
  const btn = $("signin-apikey-submit");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await client.setApiKey(key);
    await client.authenticate(METHOD.API_KEY, {});
    await enterApp();
  } catch (err) {
    signinError(`That key didn't work: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Continue";
  }
}

async function startOAuthLogin() {
  const method = client.interactiveMethod();
  if (!method) {
    signinError("No interactive login method is available.");
    return;
  }
  signinError("");

  const seq = ++state.authSeq;
  show("authing");
  resetAuthingUI(method.name || "Grok");

  // Fire authenticate WITHOUT awaiting — it blocks until the whole flow ends.
  // use_oauth forces the loopback transport (browser → localhost redirect),
  // which completes automatically once the user approves in the browser.
  const authPromise = client.authenticate(method.id, { use_oauth: true });
  let settled = false;
  authPromise.then(() => { settled = true; }, () => { settled = true; });

  // Concurrently fetch the sign-in URL. `get_url` returns null until
  // `authenticate` has installed the URL channel, so poll briefly.
  pollAuthUrl(seq, () => settled);

  try {
    await authPromise;
    if (seq !== state.authSeq) return; // cancelled
    await enterApp();
  } catch (err) {
    if (seq !== state.authSeq) return;
    show("signin");
    signinError(friendlyAuthError(err));
  }
}

async function pollAuthUrl(seq, isSettled) {
  for (let i = 0; i < 40; i++) {
    if (seq !== state.authSeq || isSettled()) return;
    let info;
    try {
      info = await client.getAuthUrl();
    } catch {
      info = null;
    }
    if (seq !== state.authSeq) return;
    const url = info && (info.auth_url || info.authUrl);
    if (url || (info && info.mode)) {
      applyAuthUrl(info);
      return;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

function resetAuthingUI(providerName) {
  $("authing-title").textContent = "Signing you in…";
  $("authing-desc").textContent =
    "We opened your browser to finish signing in. Come back here once you're done.";
  $("authing-device").classList.add("hidden");
  $("authing-open").classList.add("hidden");
  $("authing-paste").classList.add("hidden");
  $("authing-paste").open = false;
  $("authing-code-input").value = "";
  $("authing-open").dataset.url = "";
}

function applyAuthUrl(info) {
  const url = info.auth_url || info.authUrl || null;
  const mode = info.mode || (info.external_provider ? "command" : "loopback");

  if (url) {
    $("authing-open").dataset.url = url;
    $("authing-open").classList.remove("hidden");
    $("authing-url").textContent = url;
  }

  if (mode === "device") {
    $("authing-title").textContent = "Enter the code to sign in";
    $("authing-desc").textContent =
      "We opened your browser. Confirm this code matches what you see there.";
    const code = extractDeviceCode(url);
    if (code) {
      $("authing-device-code").textContent = code;
      $("authing-device").classList.remove("hidden");
    }
  } else if (mode === "command") {
    $("authing-title").textContent = "Finish signing in";
    $("authing-desc").textContent =
      "Your sign-in provider opened in the browser. Come back once you're done.";
  } else {
    $("authing-paste").classList.remove("hidden");
  }
}

function extractDeviceCode(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.searchParams.get("user_code") || u.searchParams.get("code") || null;
  } catch {
    return null;
  }
}

$("authing-open").addEventListener("click", () => {
  const url = $("authing-open").dataset.url;
  if (url) openExternal(url).catch(() => {});
});

$("authing-code-submit").addEventListener("click", () => {
  const code = $("authing-code-input").value.trim();
  if (code) client.submitAuthCode(code).catch(() => {});
});

$("authing-cancel").addEventListener("click", () => {
  state.authSeq++;
  presentSignin();
});

function friendlyAuthError(err) {
  const msg = String((err && err.message) || err);
  if (/disabled|administrator/i.test(msg)) return msg;
  return `Sign-in didn't complete: ${msg}`;
}

// ============================ ENTER APP ============================

async function enterApp() {
  show("app");
  await refreshAccount();
  state.homeDir = (await homeDir()) || "";
  // Restore the last project folder the user explicitly picked. No folder —
  // no default: chatting is gated until they choose one, so the agent never
  // scans a home directory by accident.
  state.folder = prefs.folder;
  updateFolderLabel();
  updateModelLabel();
  populateSuggestions();
  await refreshStored();
  if (state.folder && !state.chats.length) await newChat();
  updateEmptyState();
  updateComposer();
  updateModeSeg();
  $("prompt-input").focus();
}

async function refreshStored() {
  try {
    state.stored = (await listStoredSessions(120)) || [];
  } catch {
    state.stored = [];
  }
  if (!Array.isArray(state.stored)) state.stored = [];
  renderSidebar();
}

let storedRefreshTimer = null;
function scheduleStoredRefresh() {
  clearTimeout(storedRefreshTimer);
  storedRefreshTimer = setTimeout(refreshStored, 2500);
}

async function refreshAccount() {
  let info = {};
  try {
    info = await client.authInfo();
  } catch {
    /* ignore */
  }
  const name =
    [info.firstName, info.lastName].filter(Boolean).join(" ") ||
    info.email ||
    "Signed in";
  let sub = info.teamName || info.email || "";
  // Make API-key billing visible: requests on xai.api_key bill console.x.ai
  // credits with their own rate limits, NOT the user's Grok plan. Confusing
  // rate limits are usually this.
  state.authMethodId = info.methodId || null;
  if (info.methodId === "xai.api_key") {
    sub = sub ? `${sub} · API key` : "API key billing";
  }
  state.account = { email: info.email || null, name, sub };
  $("account-name").textContent = name;
  $("account-sub").textContent = sub && sub !== name ? sub : "";
  $("account-avatar").textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function populateSuggestions() {
  const box = $("empty-suggestions");
  box.textContent = "";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "suggestion";
    b.textContent = s;
    b.addEventListener("click", () => {
      if (!state.folder) { chooseFolder(); return; }
      $("prompt-input").value = s;
      autosize($("prompt-input"));
      sendPrompt();
    });
    box.appendChild(b);
  }
}

// ============================ ACCOUNT MENU ============================

$("account-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("account-menu").classList.toggle("hidden");
});
document.addEventListener("click", () => {
  $("account-menu").classList.add("hidden");
  $("model-menu").classList.add("hidden");
  hideSlashMenu();
});
$("account-menu").addEventListener("click", (e) => e.stopPropagation());

$("menu-settings").addEventListener("click", () => {
  $("account-menu").classList.add("hidden");
  openSettings();
});

$("menu-signout").addEventListener("click", async () => {
  $("account-menu").classList.add("hidden");
  try {
    await client.logout(null);
  } catch {
    /* ignore */
  }
  state.chats = [];
  state.activeChat = null;
  state.billing = null;
  state.stored = [];
  $("transcripts").textContent = "";
  $("chat-list").textContent = "";
  presentSignin();
});

// ============================ SETTINGS ============================

function openSettings() {
  $("set-yolo").checked = prefs.alwaysApprove;
  $("set-model").value = prefs.model;
  $("settings-overlay").classList.remove("hidden");
}

function closeSettings(apply) {
  $("settings-overlay").classList.add("hidden");
  if (!apply) return;
  const nextYolo = $("set-yolo").checked;
  const nextModel = $("set-model").value.trim();
  const yoloChanged = nextYolo !== prefs.alwaysApprove;
  const modelChanged = nextModel !== prefs.model;
  prefs.alwaysApprove = nextYolo;
  prefs.model = nextModel;
  if (yoloChanged || modelChanged) restartAgentAndRestore();
}

$("settings-close").addEventListener("click", () => closeSettings(true));

const MODE_IDS = ["ask", "default", "plan"];
const MODE_PLACEHOLDER = {
  ask: "Ask a question — Grok will read and explain, not edit…",
  default: "Ask Grok to build, fix, or explain something…",
  plan: "Describe the change — Grok will plan, not apply…",
};

function normalizeMode(id) {
  return MODE_IDS.includes(id) ? id : "default";
}

function applyMode(modeId, { persist = true, notify = true } = {}) {
  const id = normalizeMode(modeId);
  if (persist) prefs.mode = id;
  if (state.activeChat) state.activeChat.modeId = id;
  for (const btn of document.querySelectorAll("#mode-seg .mode-btn")) {
    btn.classList.toggle("active", btn.dataset.mode === id);
  }
  if (notify) updateComposer();
}

async function setChatMode(modeId, { persist = true } = {}) {
  const id = normalizeMode(modeId);
  applyMode(id, { persist, notify: true });
  const chat = state.activeChat;
  if (!chat?.sessionId) return;
  try {
    await client.setMode(chat.sessionId, id);
  } catch (err) {
    toast(`Couldn't switch mode: ${err.message || err}`);
  }
}

$("mode-seg").addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn || !btn.dataset.mode) return;
  e.stopPropagation();
  setChatMode(btn.dataset.mode);
});

async function restartAgentAndRestore() {
  const active = state.activeChat;
  const snapshot = active
    ? {
        sessionId: active.sessionId,
        cwd: active.folder,
        title: active.title,
        modelId: active.models?.currentModelId,
      }
    : null;
  for (const c of state.chats) {
    if (c.busy) endTurn(c);
  }
  state.restarting = true;
  toast("Restarting agent…");
  try {
    await client.start({ model: prefs.model || null, alwaysApprove: prefs.alwaysApprove });
    await silentAuth();
    state.commands = client.availableCommands();
    for (const c of state.chats) c.el.remove();
    state.chats = [];
    state.activeChat = null;
    $("transcripts").textContent = "";
    if (snapshot?.sessionId && snapshot.cwd) {
      await resumeSession({
        sessionId: snapshot.sessionId,
        cwd: snapshot.cwd,
        title: snapshot.title,
        modelId: snapshot.modelId,
      });
    } else if (state.folder) {
      await newChat();
    }
    toast("Agent restarted");
  } catch (err) {
    toast(`Couldn't restart the agent: ${err.message || err}`);
  } finally {
    state.restarting = false;
    updateComposer();
    updateModeSeg();
  }
}

function updateModeSeg() {
  applyMode(state.activeChat?.modeId || prefs.mode, { persist: false, notify: false });
}

// ============================ FOLDER ============================

async function chooseFolder() {
  const picked = await pickFolder();
  if (!picked) return;

  if (state.homeDir && picked.replace(/[\\/]+$/, "") === state.homeDir.replace(/[\\/]+$/, "")) {
    toast("That's your whole user folder — pick the specific project instead.", 4200);
    return;
  }

  state.folder = picked;
  prefs.folder = picked;
  updateFolderLabel();

  const chat = state.activeChat;
  if (chat && !chat.busy && chat.el.childElementCount === 0) {
    // Empty chat: rebind it to the new folder instead of leaving a stale cwd.
    try {
      const session = await client.newSession(picked, { yoloMode: prefs.alwaysApprove });
      chat.sessionId = session.sessionId;
      chat.folder = picked;
      applySessionInfo(chat, session);
      renderSidebar();
    } catch (err) {
      toast(`Couldn't open folder: ${err.message || err}`);
    }
  } else {
    await newChat();
  }
  updateEmptyState();
  updateComposer();
  $("prompt-input").focus();
}
$("folder-btn").addEventListener("click", chooseFolder);
$("empty-open-folder").addEventListener("click", chooseFolder);

function updateFolderLabel() {
  const f = state.folder;
  const short = f ? f.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || f : "Open a folder";
  $("folder-label").textContent = short;
  $("folder-btn").title = f || "Open a project folder";
}

// Apply per-session info from a session/new response: model state and the
// non-git-repo warning (the guard against "it scanned my whole user dir").
function applySessionInfo(chat, session) {
  chat.models = session.models || { currentModelId: null, availableModels: [] };
  updateModelLabel();
  const modes = session.modes || session.sessionModes || {};
  const fromSession = modes.currentModeId || modes.current_mode_id;
  if (fromSession) applyMode(fromSession, { persist: false, notify: false });
  const meta = session._meta || {};
  if (meta.showNonGitWarning || meta.isGitRepo === false) {
    toast("Heads up: this folder isn't a git repository. Grok works best inside a project folder.", 5000);
  }
}

// ============================ CHATS ============================

function emptyUsage() {
  return { input: 0, output: 0, costTicks: 0, costTrusted: true, turns: 0, calls: 0 };
}

function makeChatShell(sessionId, folder, title) {
  const el = document.createElement("div");
  el.className = "transcript";
  $("transcripts").appendChild(el);
  return {
    sessionId,
    title,
    el,
    turn: null,
    busy: false,
    models: null,
    usage: emptyUsage(),
    folder,
    lastAt: new Date().toISOString(),
    toolCards: new Map(),
    modeId: prefs.mode,
    _userBubble: null,
    _userBuf: "",
  };
}

function isEmptyChat(c) {
  return !c.busy && c.el.childElementCount === 0;
}

async function newChat() {
  if (!state.folder) {
    updateEmptyState();
    return;
  }
  // An untouched chat for this project IS a new chat — reuse it instead of
  // stacking "New chat" clutter in the sidebar.
  const empty = state.chats.find((c) => c.folder === state.folder && isEmptyChat(c));
  if (empty) {
    switchChat(empty);
    return;
  }

  let session;
  try {
    session = await client.newSession(state.folder, {
      yoloMode: prefs.alwaysApprove,
    });
  } catch (err) {
    toast(`Couldn't start a chat: ${err.message || err}`);
    return;
  }

  const chat = makeChatShell(session.sessionId, state.folder, "New chat");
  applySessionInfo(chat, session);
  state.chats.push(chat);
  switchChat(chat);
  if (prefs.mode && prefs.mode !== "default") {
    await setChatMode(prefs.mode, { persist: false });
  }
}

// Reopen a stored session: the agent reloads its context and replays the
// whole transcript as session/update notifications before load resolves.
async function resumeSession(stored) {
  const existing = state.chats.find((c) => c.sessionId === stored.sessionId);
  if (existing) {
    switchChat(existing);
    return;
  }

  const chat = makeChatShell(
    stored.sessionId,
    stored.cwd,
    stored.title || "Untitled chat"
  );
  chat.lastAt = stored.updatedAt || chat.lastAt;
  if (stored.modelId) chat.models = { currentModelId: stored.modelId, availableModels: [] };
  state.chats.push(chat);
  switchChat(chat);

  beginTurn(chat, true);
  setTurnStatus(chat, "Restoring conversation…");
  try {
    const result = await client.resumeSession(stored.sessionId, stored.cwd);
    if (result?.models) {
      chat.models = result.models;
      updateModelLabel();
    }
  } catch (err) {
    appendErrorNote(chat, `Couldn't restore this conversation: ${err.message || err}`);
  } finally {
    endTurn(chat);
    renderSidebar();
    updateEmptyState();
    stickToBottom = true;
    maybeScroll();
  }
}

function switchChat(chat) {
  state.activeChat = chat;
  // Garbage-collect abandoned empty chats: switching away from an untouched
  // chat discards it (its on-disk session is empty and filtered from lists).
  for (const c of [...state.chats]) {
    if (c !== chat && isEmptyChat(c)) {
      c.el.remove();
      state.chats.splice(state.chats.indexOf(c), 1);
    }
  }
  for (const c of state.chats) {
    c.el.style.display = c === chat ? "" : "none";
  }
  // A chat's project becomes the active project (new chats target it).
  if (chat.folder && chat.folder !== state.folder) {
    state.folder = chat.folder;
    prefs.folder = chat.folder;
    updateFolderLabel();
  }
  renderSidebar();
  updateComposer();
  updateEmptyState();
  updateModelLabel();
  updateUsageChip();
  updateModeSeg();
  stickToBottom = true;
  maybeScroll();
  $("prompt-input").focus();
}

function chatBySession(sessionId) {
  const id = sessionId == null ? "" : String(sessionId);
  return state.chats.find((c) => String(c.sessionId) === id);
}

$("new-chat").addEventListener("click", () => {
  if (!state.folder) { chooseFolder(); return; }
  newChat();
});

// ---- sidebar: chats grouped by project folder ----

function projectName(cwd) {
  const parts = String(cwd || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd || "unknown";
}

function timeLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 1) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days < 180) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Sidebar caps: at most this many rows per project (open chats always shown;
// stored history fills the remainder).
const MAX_ROWS_PER_PROJECT = 8;
const STORED_PER_PROJECT = 6;

function renderSidebar() {
  const nav = $("chat-list");
  nav.textContent = "";

  const openIds = new Set(state.chats.map((c) => c.sessionId));
  const groups = new Map(); // cwd -> entries
  const add = (cwd, entry) => {
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd).push(entry);
  };
  for (const c of state.chats) add(c.folder, { open: c, at: Date.parse(c.lastAt) || 0 });
  for (const s of state.stored) {
    if (openIds.has(s.sessionId)) continue;
    add(s.cwd, { stored: s, at: Date.parse(s.updatedAt) || 0 });
  }

  const latest = (cwd) => Math.max(0, ...groups.get(cwd).map((e) => e.at));
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === state.folder) return -1;
    if (b === state.folder) return 1;
    return latest(b) - latest(a);
  });

  for (const cwd of keys) {
    const wrap = document.createElement("div");
    wrap.className = "project-group";
    const head = document.createElement("div");
    head.className = "project-head";
    head.textContent = projectName(cwd);
    head.title = cwd;
    wrap.appendChild(head);

    const entries = groups.get(cwd);
    const openEntries = entries.filter((e) => e.open);
    const storedCap = Math.min(
      STORED_PER_PROJECT,
      Math.max(0, MAX_ROWS_PER_PROJECT - openEntries.length)
    );
    const storedEntries = entries
      .filter((e) => e.stored)
      .sort((a, b) => b.at - a.at)
      .slice(0, storedCap);

    for (const e of openEntries) {
      const item = document.createElement("div");
      item.className = "chat-item" + (e.open === state.activeChat ? " active" : "");
      item.textContent = e.open.title;
      item.addEventListener("click", () => switchChat(e.open));
      wrap.appendChild(item);
    }
    for (const e of storedEntries) {
      const item = document.createElement("div");
      item.className = "chat-item stored";
      const label = document.createElement("span");
      label.className = "chat-title";
      label.textContent = e.stored.title || "Untitled chat";
      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = timeLabel(e.stored.updatedAt);
      item.appendChild(label);
      item.appendChild(time);
      item.addEventListener("click", () => resumeSession(e.stored));
      wrap.appendChild(item);
    }

    nav.appendChild(wrap);
  }
}

function updateEmptyState() {
  const chat = state.activeChat;
  const noFolder = !state.folder;
  const emptyChat = chat && chat.el.childElementCount === 0;
  const showEmpty = noFolder || !chat || emptyChat;
  $("empty-state").classList.toggle("hidden", !showEmpty);
  $("empty-folder-cta").classList.toggle("hidden", !noFolder);
  $("empty-suggestions").classList.toggle("hidden", noFolder);
}

// ============================ TRANSCRIPT RENDERING ============================

const SCROLL_LOCK_PX = 80;
let stickToBottom = true;

function transcriptsEl() {
  return $("transcripts");
}

function isNearBottom(el, threshold = SCROLL_LOCK_PX) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function updateJumpLatest() {
  $("jump-latest").classList.toggle("hidden", stickToBottom);
}

function maybeScroll() {
  const box = transcriptsEl();
  if (stickToBottom) {
    box.scrollTop = box.scrollHeight;
    updateJumpLatest();
    return;
  }
  if (isNearBottom(box)) {
    stickToBottom = true;
    box.scrollTop = box.scrollHeight;
  }
  updateJumpLatest();
}

function jumpToLatest() {
  stickToBottom = true;
  const box = transcriptsEl();
  box.scrollTop = box.scrollHeight;
  updateJumpLatest();
}

transcriptsEl().addEventListener("scroll", () => {
  stickToBottom = isNearBottom(transcriptsEl());
  updateJumpLatest();
}, { passive: true });

$("jump-latest").addEventListener("click", jumpToLatest);

function addCopyButton(kind, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.dataset.copy = kind;
  btn.setAttribute("aria-label", label);
  btn.textContent = "Copy";
  return btn;
}

function addUserMessage(chat, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  const col = document.createElement("div");
  col.className = "bubble-wrap";
  col.appendChild(addCopyButton("user", "Copy message"));
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  col.appendChild(bubble);
  wrap.appendChild(col);
  chat.el.appendChild(wrap);
  updateEmptyState();
  stickToBottom = true;
  maybeScroll();
}

function beginTurn(chat, withSpinner = true) {
  const container = document.createElement("div");
  container.className = "msg msg-agent";
  chat.el.appendChild(container);

  // `spinner` doubles as the insertion anchor for streamed blocks, so it
  // always exists in the DOM; the visible "Working…" indicator is opt-in.
  const spinner = document.createElement("div");
  if (withSpinner) {
    spinner.className = "turn-spinner";
    spinner.textContent = "Working…";
  }
  container.appendChild(spinner);
  updateEmptyState();

  chat.turn = {
    container,
    spinner,
    hasSpinner: withSpinner,
    mdDiv: null,
    mdStream: null,
    textBuf: "",
    thoughtEl: null,
    thoughtBody: "",
    toolCards: new Map(),
    planEl: null,
    lastActivity: Date.now(),
    statusOverride: null,
  };
  if (withSpinner) armTurnWatchdog(chat);
}

// Working-status line under the streamed content. `override` semantics:
// a string sets a notice (retry/compaction) that wins over the default,
// null clears it, undefined re-renders the current state.
function setTurnStatus(chat, override) {
  const turn = chat.turn;
  if (!turn || !turn.hasSpinner) return;
  if (override !== undefined) turn.statusOverride = override;
  let text = turn.statusOverride;
  if (!text) {
    const quiet = Date.now() - turn.lastActivity;
    text =
      quiet > 30_000
        ? "Still working — long tasks (and rate-limit retries) can take a while. Stop cancels the turn."
        : "Working…";
  }
  turn.spinner.textContent = text;
}

function armTurnWatchdog(chat) {
  const turn = chat.turn;
  const timer = setInterval(() => {
    if (chat.turn !== turn) {
      clearInterval(timer);
      return;
    }
    setTurnStatus(chat, undefined);
  }, 5000);
}

function bumpActivity(chat) {
  if (chat.turn) {
    chat.turn.lastActivity = Date.now();
    // Fresh content clears a stale retry/slow notice.
    if (chat.turn.statusOverride) setTurnStatus(chat, null);
    else setTurnStatus(chat, undefined);
  }
}

function endTurn(chat) {
  if (chat.turn?.spinner) chat.turn.spinner.remove();
  chat.turn = null;
  chat.busy = false;
  updateComposer();
  // Titles/summaries update on disk after a turn; refresh the sidebar soon.
  scheduleStoredRefresh();
}

function sealTextBlock(turn) {
  turn.mdDiv = null;
  turn.mdStream = null;
  turn.textBuf = "";
}
function sealThought(turn) { turn.thoughtEl = null; turn.thoughtBody = ""; }

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text ?? "";
  return "";
}

const TEXT_OUTPUT_CLIP = 80_000;

function clipText(s, n = TEXT_OUTPUT_CLIP) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\n…" : s;
}

function shortPath(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || String(p);
}

function singleLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const KIND_VERB = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Run",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "Switch mode",
};

function titleCaseKind(kind) {
  return String(kind || "Tool")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function rawField(raw, ...keys) {
  if (!raw || typeof raw !== "object") return "";
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function humanToolTitle(update) {
  const kind = String(update.kind || "").toLowerCase();
  const verb = KIND_VERB[kind] || titleCaseKind(update.kind || "");
  const loc = update.locations?.[0]?.path || update.locations?.[0]?.uri;
  const raw = update.rawInput || update.raw_input || update.input || {};
  const path = loc || rawField(raw, "path", "file", "target_file", "file_path", "filename", "uri");
  const cmd = rawField(raw, "command", "cmd", "script");
  const query = rawField(raw, "query", "pattern", "regex", "search");

  if (cmd) return `${verb || "Run"} ${truncate(singleLine(cmd), 72)}`;
  if (path) return `${verb || "Read"} ${shortPath(path)}`;
  if (query) return `${verb || "Search"} ${truncate(singleLine(query), 56)}`;

  const given = (update.title || "").trim();
  if (given) {
    if (verb && given.toLowerCase().startsWith(verb.toLowerCase())) return given;
    // Agent often sends the snake_case tool id as title ("read_file").
    if (/^[a-z][a-z0-9_]*$/.test(given) && given.includes("_")) {
      return verb || titleCaseKind(given);
    }
    return verb ? `${verb} ${given}` : given;
  }
  return verb || "Tool";
}

function normalizeStatus(status) {
  if (!status) return "pending";
  return String(status)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

function renderDiff(body, d) {
  const oldText = d.oldText ?? d.old_text ?? "";
  const newText = d.newText ?? d.new_text ?? "";
  const { lines, added, deleted } = unifiedLineDiff(oldText, newText);
  const wrap = document.createElement("div");
  wrap.className = "diff";
  const path = document.createElement("div");
  path.className = "diff-path";
  const file = document.createElement("span");
  file.className = "diff-file";
  file.textContent = d.path || "file";
  const stat = document.createElement("span");
  stat.className = "diff-stat";
  const addEl = document.createElement("span");
  addEl.className = "diff-add";
  addEl.textContent = `+${added}`;
  const delEl = document.createElement("span");
  delEl.className = "diff-del";
  delEl.textContent = `−${deleted}`;
  stat.append(addEl, document.createTextNode(" / "), delEl);
  path.append(file, stat);
  wrap.appendChild(path);
  const hunk = document.createElement("div");
  hunk.className = "diff-hunk";
  for (const line of lines) {
    const row = document.createElement("div");
    row.className = `diff-line ${line.type}`;
    if (line.type === "skip") {
      row.textContent = line.text;
    } else {
      const g = document.createElement("span");
      g.className = "diff-gutter";
      g.textContent = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
      const t = document.createElement("span");
      t.className = "diff-text";
      t.textContent = line.text;
      row.append(g, t);
    }
    hunk.appendChild(row);
  }
  wrap.appendChild(hunk);
  body.appendChild(wrap);
}

function renderOutputPre(body, text) {
  const pre = document.createElement("pre");
  pre.appendChild(addCopyButton("pre", "Copy output"));
  const code = document.createElement("code");
  const clipped = clipText(text);
  code.textContent = clipped;
  pre.appendChild(code);
  body.appendChild(pre);
}

// Render ToolCallContent items (text output, file diffs) into a card body.
function renderToolContent(body, items) {
  body.textContent = "";
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "diff" || item.diff) {
      renderDiff(body, item.diff || item);
    } else {
      const text = contentText(item.content ?? item);
      if (!text) continue;
      renderOutputPre(body, text);
    }
  }
}

const TURN_CONTENT = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

function handleUpdate(params) {
  const update = params.update ?? {};
  const sessionId = params.sessionId || params.session_id;

  // Non-turn notifications we care about.
  if (update.sessionUpdate === "available_commands_update") {
    state.commands = update.availableCommands || [];
    return;
  }
  if (update.sessionUpdate === "current_mode_update") {
    const modeId = update.currentModeId || update.current_mode_id || update.modeId;
    const chat = chatBySession(sessionId);
    if (chat) chat.modeId = normalizeMode(modeId);
    if (chat && chat === state.activeChat) applyMode(modeId, { persist: true, notify: true });
    return;
  }

  const chat = chatBySession(sessionId);
  if (!chat) return;

  // Replayed user turns (session/load restores the whole transcript).
  if (update.sessionUpdate === "user_message_chunk") {
    // During a live turn the agent echoes the prompt we already rendered
    // locally — drawing it again duplicates the user's message. Only render
    // user chunks outside our own turns (i.e. session/load replay).
    if (chat.busy) return;
    if (update.content?._meta?.hideFromScrollback || update._meta?.hideFromScrollback) return;
    const text = contentText(update.content);
    if (!text) return;
    // A user message ends any open agent turn.
    if (chat.turn) {
      chat.turn.spinner.remove();
      chat.turn = null;
    }
    if (chat._userBubble) {
      chat._userBuf += text;
      chat._userBubble.textContent = chat._userBuf;
    } else {
      const wrap = document.createElement("div");
      wrap.className = "msg msg-user";
      const col = document.createElement("div");
      col.className = "bubble-wrap";
      col.appendChild(addCopyButton("user", "Copy message"));
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;
      col.appendChild(bubble);
      wrap.appendChild(col);
      chat.el.appendChild(wrap);
      chat._userBubble = bubble;
      chat._userBuf = text;
    }
    updateEmptyState();
    maybeScroll();
    return;
  }

  // Late tool_call_update after endTurn must still land on the existing card.
  if (update.sessionUpdate === "tool_call_update") {
    const existing = chat.toolCards.get(update.toolCallId);
    if (existing) {
      applyToolCardUpdate(existing, update);
      if (chat.turn) bumpActivity(chat);
      maybeScroll();
      return;
    }
  }

  if (!TURN_CONTENT.has(update.sessionUpdate)) return;

  // Any agent content closes the current merged user bubble.
  chat._userBubble = null;
  chat._userBuf = "";

  // Content arriving outside a prompt we initiated gets no "Working…" spinner.
  if (!chat.turn) beginTurn(chat, chat.busy);
  const turn = chat.turn;
  bumpActivity(chat);

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      sealThought(turn);
      if (!turn.mdDiv) {
        turn.mdDiv = document.createElement("div");
        turn.mdDiv.className = "md";
        turn.container.insertBefore(turn.mdDiv, turn.spinner);
        turn.mdStream = createMdStream();
      }
      turn.textBuf += contentText(update.content);
      updateMdStream(turn.mdDiv, turn.mdStream, turn.textBuf);
      break;
    }
    case "agent_thought_chunk": {
      sealTextBlock(turn);
      if (!turn.thoughtEl) {
        const details = document.createElement("details");
        details.className = "thought";
        details.innerHTML = '<summary>Thinking…</summary><div class="thought-body"></div>';
        turn.container.insertBefore(details, turn.spinner);
        turn.thoughtEl = details;
      }
      turn.thoughtBody += contentText(update.content);
      turn.thoughtEl.querySelector(".thought-body").textContent = turn.thoughtBody;
      break;
    }
    case "tool_call": {
      sealTextBlock(turn);
      sealThought(turn);
      const entry = createToolCard(chat, turn, update);
      if (update.content?.length) {
        renderToolContent(entry.body, update.content);
        entry.body.classList.remove("hidden");
        entry.caret.classList.remove("hidden");
      }
      break;
    }
    case "tool_call_update": {
      let card = turn.toolCards.get(update.toolCallId) || chat.toolCards.get(update.toolCallId);
      if (!card) {
        // Update arrived before the start notification — synthesize a card.
        card = createToolCard(chat, turn, update);
      }
      applyToolCardUpdate(card, update);
      break;
    }
    case "plan": {
      sealTextBlock(turn);
      if (!turn.planEl) {
        turn.planEl = document.createElement("div");
        turn.planEl.className = "plan";
        turn.container.insertBefore(turn.planEl, turn.spinner);
      }
      turn.planEl.innerHTML = '<div class="plan-title">Plan</div>';
      for (const e of update.entries || []) {
        const cls = ["pending", "in_progress", "completed"].includes(e.status) ? e.status : "pending";
        const mark = cls === "completed" ? "☑" : cls === "in_progress" ? "▸" : "☐";
        const row = document.createElement("div");
        row.className = `plan-entry ${cls}`;
        const m = document.createElement("span");
        m.textContent = mark;
        const t = document.createElement("span");
        t.textContent = contentText(e.content) || String(e.content ?? "");
        row.appendChild(m);
        row.appendChild(t);
        turn.planEl.appendChild(row);
      }
      break;
    }
    default:
      break;
  }
  maybeScroll();
}

function createToolCard(chat, turn, update) {
  const card = document.createElement("details");
  card.className = "tool-call";
  const summary = document.createElement("summary");
  const status = document.createElement("span");
  status.className = `tool-status ${normalizeStatus(update.status)}`;
  const title = document.createElement("span");
  title.className = "tool-title";
  title.textContent = humanToolTitle(update);
  const caret = document.createElement("span");
  caret.className = "tool-caret hidden";
  caret.textContent = "▶";
  summary.appendChild(status);
  summary.appendChild(title);
  summary.appendChild(caret);
  card.appendChild(summary);
  const body = document.createElement("div");
  body.className = "tool-body hidden";
  card.appendChild(body);
  turn.container.insertBefore(card, turn.spinner);
  const entry = { statusEl: status, titleEl: title, body, caret, update };
  if (update.toolCallId) {
    turn.toolCards.set(update.toolCallId, entry);
    chat.toolCards.set(update.toolCallId, entry);
  }
  return entry;
}

function applyToolCardUpdate(card, update) {
  if (update.status) card.statusEl.className = `tool-status ${normalizeStatus(update.status)}`;
  const merged = { ...(card.update || {}), ...update };
  if (update.rawInput || update.raw_input || update.input || update.locations || update.kind || update.title) {
    card.update = merged;
    card.titleEl.textContent = humanToolTitle(merged);
  }
  if (update.content?.length) {
    renderToolContent(card.body, update.content);
    card.body.classList.remove("hidden");
    card.caret.classList.remove("hidden");
  }
}

client.onSessionUpdate = handleUpdate;

// ---- retry / compaction side channel (x.ai/session_notification) ----
//
// When the backend rate-limits, the agent retries with backoff instead of
// failing the turn. Without surfacing retry_state the UI looks hung.
client.onSessionNotification = (params) => {
  const chat = chatBySession(params?.sessionId || params?.session_id);
  if (!chat) return;
  const update = params.update || {};

  switch (update.sessionUpdate) {
    case "retry_state": {
      if (update.type === "retrying") {
        const reason = shortReason(update.reason);
        // RetryState fields are snake_case on the wire (max_retries,
        // is_rate_limited, error_type); camelCase kept as fallback.
        const max = update.max_retries ?? update.maxRetries;
        const attempts = `attempt ${update.attempt}${max ? ` of ${max}` : ""}`;
        const label = /rate.?limit|429/i.test(reason)
          ? "Rate limited by the server"
          : /50\d|unavailable|overloaded|connect error|connection|timeout/i.test(reason)
          ? "Grok's servers are having a moment"
          : `Hit a snag (${reason})`;
        setTurnStatus(chat, `${label} — retrying (${attempts})…`);
      } else if (update.type === "exhausted") {
        const msg = update.is_rate_limited || update.isRateLimited
          ? "Rate limit persisted through all retries. Your plan's limit likely needs a few minutes to reset — try again shortly."
          : `Gave up after ${update.attempts} attempts: ${shortReason(update.reason)}`;
        appendErrorNote(chat, msg);
        setTurnStatus(chat, null);
      } else if (update.type === "failed") {
        const authy = update.error_type === "auth" || update.errorType === "auth";
        const raw = update.message || "The request failed.";
        appendErrorNote(
          chat,
          authy
            ? `${raw}\n\nSign out and back in from the account menu.`
            : friendlyRpcError({ message: raw })
        );
        setTurnStatus(chat, null);
      }
      break;
    }
    case "auto_compact_started":
      setTurnStatus(chat, `Conversation is long (${update.percentage ?? "?"}% of context) — compacting…`);
      break;
    case "auto_compact_completed":
      setTurnStatus(chat, null);
      break;
    case "auto_compact_failed":
      setTurnStatus(chat, null);
      break;
    default:
      break;
  }
};

// Retry reasons can be a full request/response dump (URL, headers, cookies).
// Keep the first meaningful line, capped, for the one-line status banner.
function shortReason(reason) {
  if (!reason) return "transient error";
  let r = String(reason).split(/Request URL:|Request headers:|Response headers:/)[0];
  r = r.split("\n")[0].trim().replace(/[.,;:\s]+$/, "");
  if (r.length > 140) r = r.slice(0, 140) + "…";
  return r || "transient error";
}

function appendErrorNote(chat, msg) {
  const text = String(msg || "").trim();
  if (!text) return;
  if (chat.lastErrorNote === text) return;
  chat.lastErrorNote = text;
  const note = document.createElement("div");
  note.className = "error-note";
  note.textContent = text;
  (chat.turn?.container || chat.el).appendChild(note);
  maybeScroll();
}

// ============================ PERMISSIONS ============================

// Permission requests can arrive concurrently (parallel tool calls). The
// modal shows one at a time; without this queue a second request would
// overwrite the first's dialog and orphan its promise — the agent then waits
// on the unanswered request forever and the whole session looks hung.
let permQueue = Promise.resolve();
let permPending = 0;
let permDeny = null;
let agentPromptCancel = null;

const ENABLE_ALWAYS_APPROVE_ID = "enable-always-approve";

client.onPermissionRequest = (params) => {
  permPending++;
  updatePermWaiting();
  const turn = permQueue.then(() => showPermissionModal(params));
  permQueue = turn.then(
    () => { permPending--; updatePermWaiting(); },
    () => { permPending--; updatePermWaiting(); }
  );
  return turn;
};

// Desktop reverse-requests. 1.1.0 advertised clientType Desktop; the agent
// then sends folder-trust / plan-approval / ask-user-question RPCs. If we
// reply "method not supported" the turn waits forever and Send looks dead.
client.onFolderTrustRequest = async (params) => {
  const cwd = params?.cwd || params?.workspace || "";
  const kinds = (params?.configKinds || params?.config_kinds || []).join(", ");
  const ok = await showAgentPrompt({
    badge: "Folder trust",
    title: "Trust this project folder?",
    bodyHtml: `<p class="muted">Grok wants to load project-local config${kinds ? ` (${escapePrompt(kinds)})` : ""} from:</p><p><code>${escapePrompt(cwd)}</code></p><p class="muted small">You already opened this folder. Trust lets repo MCP servers, hooks, and plugins run.</p>`,
    actions: [
      { label: "Trust folder", cls: "btn btn-primary", result: { outcome: "trust" } },
      { label: "Not now", cls: "btn", result: { outcome: "reject" } },
    ],
    cancel: { outcome: "reject" },
  });
  return ok;
};

client.onExitPlanMode = async (params) => {
  const plan = params?.planContent || params?.plan_content || "";
  const ok = await showAgentPrompt({
    badge: "Plan",
    title: "Approve this plan?",
    bodyHtml: plan
      ? `<pre class="perm-pre">${escapePrompt(plan)}</pre>`
      : `<p class="muted">Grok finished planning and wants to start making changes.</p>`,
    actions: [
      { label: "Approve", cls: "btn btn-primary", result: { outcome: "approved" } },
      { label: "Keep planning", cls: "btn", result: { outcome: "cancelled" } },
    ],
    cancel: { outcome: "cancelled" },
  });
  return ok;
};

client.onAskUserQuestion = async (params) => {
  const questions = params?.questions || [];
  const answers = {};
  const body = document.createElement("div");
  body.className = "ask-list";
  for (const q of questions) {
    const header = q.header || q.question || q.prompt || "Question";
    const id = q.header || q.question || header;
    const wrap = document.createElement("div");
    wrap.className = "ask-q";
    const h = document.createElement("div");
    h.className = "ask-h";
    h.textContent = header;
    wrap.appendChild(h);
    if (q.question && q.question !== header) {
      const p = document.createElement("p");
      p.className = "muted small";
      p.textContent = q.question;
      wrap.appendChild(p);
    }
    const opts = q.options || [];
    if (opts.length) {
      const row = document.createElement("div");
      row.className = "ask-opts";
      for (const opt of opts) {
        const label = opt.label || opt.name || String(opt);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip";
        btn.textContent = label;
        btn.addEventListener("click", () => {
          answers[id] = [label];
          for (const b of row.querySelectorAll("button")) b.classList.remove("active");
          btn.classList.add("active");
        });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Your answer…";
      input.addEventListener("input", () => {
        const v = input.value.trim();
        if (v) answers[id] = [v];
        else delete answers[id];
      });
      wrap.appendChild(input);
    }
    body.appendChild(wrap);
  }
  const result = await showAgentPrompt({
    badge: "Question",
    title: questions.length > 1 ? "Grok has a few questions" : "Grok has a question",
    bodyNode: body,
    actions: [
      { label: "Submit", cls: "btn btn-primary", result: "submit" },
      { label: "Skip", cls: "btn", result: { outcome: "cancelled" } },
    ],
    cancel: { outcome: "cancelled" },
  });
  if (result === "submit") return { outcome: "accepted", answers };
  return result;
};

function escapePrompt(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showAgentPrompt({ badge, title, bodyHtml, bodyNode, actions, cancel }) {
  return new Promise((resolve) => {
    const overlay = $("agent-prompt-overlay");
    $("agent-prompt-badge").textContent = badge || "Grok";
    $("agent-prompt-title").textContent = title || "Grok needs a decision";
    const body = $("agent-prompt-body");
    body.textContent = "";
    if (bodyNode) body.appendChild(bodyNode);
    else body.innerHTML = bodyHtml || "";
    const box = $("agent-prompt-options");
    box.textContent = "";
    const finish = (value) => {
      overlay.classList.add("hidden");
      overlay.onclick = null;
      agentPromptCancel = null;
      resolve(value);
    };
    agentPromptCancel = () => finish(cancel);
    for (const a of actions || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = a.cls || "btn";
      btn.textContent = a.label;
      btn.addEventListener("click", () => finish(a.result));
      box.appendChild(btn);
    }
    overlay.onclick = (e) => {
      if (e.target === overlay) finish(cancel);
    };
    overlay.classList.remove("hidden");
  });
}

function updatePermWaiting() {
  const el = $("perm-waiting");
  const extra = Math.max(0, permPending - 1);
  el.classList.toggle("hidden", extra === 0);
  el.textContent = extra === 1 ? "1 more waiting" : `${extra} more waiting`;
}

function pickRaw(raw, ...keys) {
  if (!raw || typeof raw !== "object") return "";
  for (const k of keys) {
    const v = raw[k];
    if (v == null || v === "") continue;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

function addPermField(parent, label, value, { pre = false, cls = "" } = {}) {
  if (!value) return;
  const field = document.createElement("div");
  field.className = "perm-field";
  const k = document.createElement("div");
  k.className = "perm-k";
  k.textContent = label;
  field.appendChild(k);
  if (pre) {
    const block = document.createElement("pre");
    const code = document.createElement("code");
    const text = String(value);
    code.textContent = text.length > 80_000 ? text.slice(0, 80_000) + "\n…" : text;
    block.appendChild(code);
    field.appendChild(block);
  } else {
    const v = document.createElement("div");
    v.className = "perm-v" + (cls ? ` ${cls}` : "");
    v.textContent = value;
    field.appendChild(v);
  }
  parent.appendChild(field);
}

function renderPermissionReview(body, tool) {
  body.textContent = "";
  const raw = tool.rawInput ?? tool.raw_input ?? tool.input ?? {};
  const loc = tool.locations?.[0]?.path || tool.locations?.[0]?.uri || "";
  const command = pickRaw(raw, "command", "cmd", "script");
  const path = loc || pickRaw(raw, "path", "target_file", "file_path", "file", "filename");
  const contents = pickRaw(raw, "contents", "content", "new_string", "new_text", "text");
  const oldText = pickRaw(raw, "old_string", "old_text");
  const query = pickRaw(raw, "query", "pattern", "regex", "search");
  const url = pickRaw(raw, "url", "uri");
  const known = new Set([
    "command", "cmd", "script", "path", "target_file", "file_path", "file", "filename",
    "contents", "content", "new_string", "new_text", "text", "old_string", "old_text",
    "query", "pattern", "regex", "search", "url", "uri",
  ]);

  if (command) addPermField(body, "Command", command, { pre: true, cls: "cmd" });
  if (path) addPermField(body, "Path", path);
  if (url && url !== path) addPermField(body, "URL", url);
  if (query) addPermField(body, "Search", query);
  if (oldText) addPermField(body, "Replace", oldText, { pre: true });
  if (contents) addPermField(body, command ? "Input" : "Contents", contents, { pre: true });

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (known.has(k) || v == null || v === "") continue;
      if (typeof v === "object") continue;
      addPermField(body, k.replace(/_/g, " "), String(v));
    }
  }

  if (!body.childElementCount && raw !== undefined) {
    addPermField(
      body,
      "Details",
      typeof raw === "string" ? raw : JSON.stringify(raw, null, 2),
      { pre: true }
    );
  }
}

function classifyPermOption(opt) {
  const id = String(opt.optionId || opt.option_id || "");
  const kind = String(opt.kind || "").toLowerCase();
  if (id === ENABLE_ALWAYS_APPROVE_ID) return "always";
  if (id === "allow-edits-session" || id === "always-allow" || id.startsWith("allow-always")) return "always";
  if (kind === "allowalways" || kind === "allow_always") return "always";
  if (kind === "allowonce" || kind === "allow_once" || id === "allow-once") return "allow";
  if (kind === "rejectonce" || kind === "reject_once" || id === "reject-once") return "deny";
  if (/reject|deny|cancel/.test(kind) || /reject|deny|cancel/.test(id)) return "deny";
  if (/allow/.test(kind) || /allow/.test(id)) return "allow";
  return "other";
}

const showPermissionModal = (params) =>
  new Promise((resolve) => {
    const overlay = $("perm-overlay");
    const body = $("perm-body");
    const optionsBox = $("perm-options");
    const tool = params.toolCall || params.tool_call || {};
    $("perm-title").textContent = tool.title || "Grok wants to run an action";
    renderPermissionReview(body, tool);
    optionsBox.textContent = "";
    updatePermWaiting();

    const options = params.options || [];
    const pick = (role) => options.find((o) => classifyPermOption(o) === role);

    const finish = (outcome) => {
      permDeny = null;
      overlay.classList.add("hidden");
      resolve(outcome);
    };

    const deny = () => {
      const opt = pick("deny");
      if (opt) finish({ outcome: "selected", optionId: opt.optionId || opt.option_id });
      else finish({ outcome: "cancelled" });
    };
    permDeny = deny;

    const addBtn = (label, cls, onClick) => {
      const btn = document.createElement("button");
      btn.className = cls;
      btn.textContent = label;
      btn.addEventListener("click", onClick);
      optionsBox.appendChild(btn);
    };

    const allow = pick("allow") || options.find((o) => /allow/i.test(o.kind || o.name || ""));
    const always = pick("always");

    if (allow) {
      addBtn("Allow", "btn btn-primary", () => {
        finish({ outcome: "selected", optionId: allow.optionId || allow.option_id });
      });
    }
    addBtn("Allow always", "btn", () => {
      if (always) {
        const id = always.optionId || always.option_id;
        if (id === ENABLE_ALWAYS_APPROVE_ID) {
          prefs.alwaysApprove = true;
          client.yoloModeChanged({ yoloMode: true, permissionMode: "always-approve" });
        }
        finish({ outcome: "selected", optionId: id });
        return;
      }
      prefs.alwaysApprove = true;
      client.yoloModeChanged({ yoloMode: true, permissionMode: "always-approve" });
      if (allow) finish({ outcome: "selected", optionId: allow.optionId || allow.option_id });
      else finish({ outcome: "cancelled" });
    });
    addBtn("Deny", "btn", deny);

    overlay.classList.remove("hidden");
  });

$("perm-overlay").addEventListener("click", (e) => {
  if (e.target === $("perm-overlay") && permDeny) permDeny();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("agent-prompt-overlay").classList.contains("hidden") && agentPromptCancel) {
    e.preventDefault();
    agentPromptCancel();
    return;
  }
  if (!$("perm-overlay").classList.contains("hidden") && permDeny) {
    e.preventDefault();
    permDeny();
    return;
  }
  if (!$("settings-overlay").classList.contains("hidden")) {
    e.preventDefault();
    closeSettings(false);
    return;
  }
  if (!$("usage-overlay").classList.contains("hidden")) {
    e.preventDefault();
    $("usage-overlay").classList.add("hidden");
  }
});

$("settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("settings-overlay")) closeSettings(false);
});

// ============================ USAGE ============================

const TICKS_PER_USD = 1e10;

function addUsage(chat, u) {
  if (!u || typeof u !== "object") return;
  const s = chat.usage;
  s.input += u.inputTokens || 0;
  s.output += u.outputTokens || 0;
  s.turns += u.numTurns || 0;
  s.calls += u.modelCalls || 0;
  if (u.costUsdTicks != null) s.costTicks += u.costUsdTicks;
  else if ((u.inputTokens || 0) + (u.outputTokens || 0) > 0) s.costTrusted = false;
  if (u.usageIsIncomplete) s.costTrusted = false;
  updateUsageChip();
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
}

function fmtUsd(x) {
  if (x > 0 && x < 0.01) return "<$0.01";
  return "$" + x.toFixed(2);
}

function updateUsageChip() {
  const s = state.activeChat?.usage;
  const label = $("usage-label");
  if (!s || s.input + s.output === 0) {
    label.textContent = "Usage";
    return;
  }
  let text = `${fmtTokens(s.input + s.output)} tok`;
  if (s.costTicks > 0 && s.costTrusted) text += ` · ${fmtUsd(s.costTicks / TICKS_PER_USD)}`;
  label.textContent = text;
}

$("usage-btn").addEventListener("click", openUsage);
$("usage-close").addEventListener("click", () => $("usage-overlay").classList.add("hidden"));
$("usage-refresh").addEventListener("click", () => {
  state.billing = null; // bust the cache
  openUsage();
});

function usageStat(v, k) {
  const div = document.createElement("div");
  div.className = "usage-stat";
  const vv = document.createElement("div");
  vv.className = "v";
  vv.textContent = v;
  const kk = document.createElement("div");
  kk.className = "k";
  kk.textContent = k;
  div.appendChild(vv);
  div.appendChild(kk);
  return div;
}

async function openUsage() {
  $("usage-overlay").classList.remove("hidden");

  // This chat.
  const grid = $("usage-session");
  grid.textContent = "";
  const s = state.activeChat?.usage || emptyUsage();
  grid.appendChild(usageStat(fmtTokens(s.input), "tokens in"));
  grid.appendChild(usageStat(fmtTokens(s.output), "tokens out"));
  grid.appendChild(usageStat(String(s.calls), "model calls"));
  grid.appendChild(
    usageStat(s.costTicks > 0 && s.costTrusted ? fmtUsd(s.costTicks / TICKS_PER_USD) : "—", "cost")
  );

  // Account/billing (cached for a minute).
  const box = $("usage-account");
  const tierEl = $("usage-tier");
  const now = Date.now();
  if (!state.billing || now - state.billing.at > 60_000) {
    box.innerHTML = '<p class="muted small">Loading…</p>';
    try {
      const data = await client.billing();
      state.billing = { at: now, data };
    } catch (err) {
      state.billing = { at: now, error: String(err.message || err) };
    }
  }
  renderBilling(box, tierEl, state.billing);
}

// Mirrors the official pager's credit_balance_from_config derivation:
// percent from creditUsagePercent (else used/limit), Weekly/Monthly label
// from the period type, floored percent (backend truncates the same way),
// signed prepaid cents (negative = balance, accounting convention).
function renderBilling(box, tierEl, billing) {
  box.textContent = "";
  tierEl.classList.add("hidden");

  if (billing.error) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = `Plan usage isn't available right now (${billing.error}).`;
    box.appendChild(p);
    return;
  }

  const resp = billing.data || {};
  const cfg = resp.config || {};

  if (resp.subscriptionTier) {
    tierEl.textContent = resp.subscriptionTier;
    tierEl.classList.remove("hidden");
  }

  const centsVal = (c) => (c && typeof c.val === "number" ? c.val : null);

  const limitC = centsVal(cfg.monthlyLimit) ?? 0;
  const usedC = centsVal(cfg.used) ?? 0;
  let pct = cfg.creditUsagePercent;
  if (pct == null) pct = limitC > 0 ? Math.min((usedC / limitC) * 100, 100) : null;
  if (pct != null) pct = Math.min(Math.max(pct, 0), 100);

  const periodType = cfg.currentPeriod?.type || "";
  const planLabel = periodType.includes("WEEKLY")
    ? "Weekly limit"
    : periodType.includes("MONTHLY")
    ? "Monthly limit"
    : "Plan usage";

  if (pct != null) {
    const pctFloor = Math.floor(pct);
    const label = document.createElement("div");
    label.className = "usage-row";
    const kk = document.createElement("span");
    kk.textContent = planLabel;
    const r = document.createElement("span");
    r.className = "r";
    r.textContent = `${pctFloor}% used · ${100 - pctFloor}% left`;
    label.appendChild(kk);
    label.appendChild(r);
    box.appendChild(label);

    const bar = document.createElement("div");
    bar.className = "credit-bar";
    const fill = document.createElement("div");
    fill.style.width = `${pct}%`;
    if (pct >= 90) fill.className = "hot";
    bar.appendChild(fill);
    box.appendChild(bar);
  }

  const rows = [];
  if (state.authMethodId) {
    rows.push([
      "Billing via",
      state.authMethodId === "xai.api_key" ? "API key (console.x.ai)" : "Grok account",
    ]);
  }
  // Absolute plan dollars only exist on the legacy shape; show when present.
  if (limitC > 0) {
    rows.push([
      "Included credits",
      `${fmtUsd(usedC / 100)} used of ${fmtUsd(limitC / 100)} · ${fmtUsd(Math.max(limitC - usedC, 0) / 100)} left`,
    ]);
  }
  const end = cfg.currentPeriod?.end || cfg.billingPeriodEnd;
  if (end) {
    const d = new Date(end);
    if (!isNaN(d)) {
      rows.push([
        "Resets",
        d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
      ]);
    }
  }
  const odCapC = centsVal(cfg.onDemandCap);
  const odUsedC = centsVal(cfg.onDemandUsed) ?? (limitC > 0 ? Math.max(usedC - limitC, 0) : null);
  if (resp.onDemandEnabled !== false && odCapC != null && odCapC > 0) {
    rows.push([
      "On-demand",
      `${fmtUsd((odUsedC ?? 0) / 100)} used of ${fmtUsd(odCapC / 100)} · ${fmtUsd(Math.max(odCapC - (odUsedC ?? 0), 0) / 100)} left`,
    ]);
  } else if (odUsedC != null && odUsedC > 0) {
    rows.push(["On-demand", `${fmtUsd(odUsedC / 100)} used`]);
  }
  // Prepaid balances arrive as negative cents (accounting convention).
  const prepaidC = centsVal(cfg.prepaidBalance);
  if (prepaidC != null && prepaidC !== 0) {
    rows.push(["Credit balance", `${fmtUsd(Math.abs(prepaidC) / 100)} available`]);
  }

  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const kk = document.createElement("span");
    kk.textContent = k;
    const vv = document.createElement("span");
    vv.className = "r";
    vv.textContent = v;
    row.appendChild(kk);
    row.appendChild(vv);
    box.appendChild(row);
  }

  // Past billing periods.
  const history = (cfg.history || []).slice(-3).reverse();
  for (const h of history) {
    const cyc = h.billingCycle;
    const total = centsVal(h.totalUsed) ?? centsVal(h.includedUsed);
    if (!cyc || total == null) continue;
    const name = new Date(cyc.year, (cyc.month || 1) - 1).toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
    });
    const row = document.createElement("div");
    row.className = "usage-row";
    const kk = document.createElement("span");
    kk.textContent = name;
    const vv = document.createElement("span");
    vv.className = "r";
    vv.textContent = fmtUsd(total / 100);
    row.appendChild(kk);
    row.appendChild(vv);
    box.appendChild(row);
  }

  if (!box.childElementCount) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent =
      "No plan usage reported for this account. If you're on an API key, spend lives at console.x.ai.";
    box.appendChild(p);
  }
}

// ============================ MODEL PICKER ============================

function updateModelLabel() {
  const chat = state.activeChat;
  const current = chat?.models?.currentModelId;
  $("model-label").textContent = current || prefs.model || "Default model";
}

$("model-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("model-menu");
  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    return;
  }
  const chat = state.activeChat;
  const models = chat?.models?.availableModels || [];
  menu.textContent = "";

  if (!models.length) {
    const item = document.createElement("button");
    item.className = "menu-item";
    item.textContent = "No other models available";
    item.disabled = true;
    menu.appendChild(item);
  } else {
    for (const m of models) {
      const id = m.modelId || m.id || String(m);
      const name = m.name || id;
      const item = document.createElement("button");
      item.className = "menu-item";
      if (id === chat.models.currentModelId) item.classList.add("selected");
      const label = document.createElement("span");
      label.textContent = name;
      const mark = document.createElement("span");
      mark.className = "check-mark";
      mark.textContent = "✓";
      item.appendChild(label);
      item.appendChild(mark);
      item.addEventListener("click", async () => {
        menu.classList.add("hidden");
        try {
          await client.setModel(chat.sessionId, id);
          chat.models.currentModelId = id;
          updateModelLabel();
          toast(`Model set to ${name}`);
        } catch (err) {
          toast(`Couldn't switch model: ${err.message || err}`);
        }
      });
      menu.appendChild(item);
    }
  }
  menu.classList.remove("hidden");
});
$("model-menu").addEventListener("click", (e) => e.stopPropagation());

// ============================ SLASH COMMANDS ============================

const slash = { items: [], active: 0 };

function slashQuery() {
  const v = $("prompt-input").value;
  if (!v.startsWith("/") || /\s/.test(v)) return null;
  return v.slice(1).toLowerCase();
}

function updateSlashMenu() {
  const q = slashQuery();
  const menu = $("slash-menu");
  if (q === null || !state.commands.length) {
    hideSlashMenu();
    return;
  }
  slash.items = state.commands.filter((c) => c.name.toLowerCase().startsWith(q));
  if (!slash.items.length) {
    hideSlashMenu();
    return;
  }
  slash.active = Math.min(slash.active, slash.items.length - 1);
  menu.textContent = "";
  slash.items.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.className = "slash-item" + (i === slash.active ? " active" : "");
    const name = document.createElement("span");
    name.className = "slash-name";
    name.textContent = `/${c.name}`;
    const desc = document.createElement("span");
    desc.className = "slash-desc";
    desc.textContent = c.description || "";
    btn.appendChild(name);
    btn.appendChild(desc);
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSlash(i);
    });
    menu.appendChild(btn);
  });
  menu.classList.remove("hidden");
}

function hideSlashMenu() {
  $("slash-menu").classList.add("hidden");
  slash.items = [];
  slash.active = 0;
}

function pickSlash(i) {
  const c = slash.items[i];
  if (!c) return;
  const input = $("prompt-input");
  input.value = `/${c.name} `;
  hideSlashMenu();
  input.focus();
  autosize(input);
}

// ============================ COMPOSER ============================

function updateComposer() {
  const busy = !!state.activeChat?.busy;
  // Usable whenever a chat is active (a resumed chat carries its own folder);
  // otherwise gated until a project folder is opened.
  const gated = !state.activeChat && !state.folder;
  $("send-btn").classList.toggle("hidden", busy);
  $("stop-btn").classList.toggle("hidden", !busy);
  const input = $("prompt-input");
  input.disabled = gated;
  const mode = state.activeChat?.modeId || prefs.mode;
  input.placeholder = gated
    ? "Open a project folder to start…"
    : MODE_PLACEHOLDER[mode] || MODE_PLACEHOLDER.default;
  $("composer-inner").classList.toggle("disabled", gated);
  $("send-btn").disabled = gated;
}

async function sendPrompt() {
  const input = $("prompt-input");
  const text = input.value.trim();
  if (!text) return;

  hideSlashMenu();

  // 1.1.0 could leave the composer looking enabled (saved folder, no session
  // yet — session/new failed or still in flight) and then silently return.
  let chat = state.activeChat;
  if (!chat) {
    if (!state.folder) {
      toast("Open a project folder to start a chat.");
      return;
    }
    await newChat();
    chat = state.activeChat;
    if (!chat) {
      toast("Couldn't start a chat — pick the project folder again.");
      return;
    }
  }
  if (chat.busy) return;

  input.value = "";
  autosize(input);

  if (chat.title === "New chat") {
    chat.title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
  }
  chat.lastAt = new Date().toISOString();
  renderSidebar();

  addUserMessage(chat, text);
  beginTurn(chat);
  chat.busy = true;
  chat.lastErrorNote = null;
  updateComposer();

  try {
    const result = await client.prompt(chat.sessionId, text, {
      mode: chat.modeId || prefs.mode,
    });
    addUsage(chat, result?._meta?.usage);
  } catch (err) {
    appendErrorNote(chat, friendlyRpcError(err));
  } finally {
    endTurn(chat);
    maybeScroll();
  }
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

$("send-btn").addEventListener("click", sendPrompt);
$("stop-btn").addEventListener("click", () => {
  const chat = state.activeChat;
  if (chat?.busy) client.cancel(chat.sessionId);
});

$("prompt-input").addEventListener("keydown", (e) => {
  if (slash.items.length) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slash.active = (slash.active + 1) % slash.items.length;
      updateSlashMenu();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slash.active = (slash.active - 1 + slash.items.length) % slash.items.length;
      updateSlashMenu();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      pickSlash(slash.active);
      return;
    }
    if (e.key === "Escape") {
      hideSlashMenu();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$("prompt-input").addEventListener("input", (e) => {
  autosize(e.target);
  updateSlashMenu();
});

// ============================ AGENT LIFECYCLE ============================

client.onYoloModeChanged = (params) => {
  const yolo = params.yolo_mode ?? params.yoloMode;
  if (typeof yolo === "boolean") {
    prefs.alwaysApprove = yolo;
    if (!$("settings-overlay").classList.contains("hidden")) {
      $("set-yolo").checked = yolo;
    }
  }
};

client.onExit = () => {
  if (state.restarting) return;
  for (const chat of state.chats) if (chat.busy) endTurn(chat);
  const active = state.activeChat;
  if (active) {
    const note = document.createElement("div");
    note.className = "error-note";
    note.textContent =
      "The agent process stopped." +
      (state.stderrTail.length ? `\n\n${state.stderrTail.join("\n")}` : "") +
      "\n\nReopen the app to reconnect.";
    active.el.appendChild(note);
    maybeScroll();
  }
  toast("Agent stopped");
};

client.onStderr = (line) => {
  state.stderrTail.push(line);
  if (state.stderrTail.length > 8) state.stderrTail.shift();
};

// External links from markdown open in the system browser.
// Copy buttons on <pre> and user bubbles use the same delegation.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-external]");
  if (a) {
    e.preventDefault();
    openExternal(a.getAttribute("href")).catch(() => {});
    return;
  }
  const btn = e.target.closest("[data-copy]");
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    copyFromButton(btn);
  }
});

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function copyFromButton(btn) {
  let text = "";
  if (btn.dataset.copy === "user") {
    text = btn.closest(".bubble-wrap")?.querySelector(".bubble")?.textContent || "";
  } else {
    const pre = btn.closest("pre");
    text = pre?.querySelector("code")?.textContent ?? pre?.textContent ?? "";
  }
  copyText(text).then((ok) => {
    if (!ok) return;
    const prev = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("copied");
    clearTimeout(btn._copiedT);
    btn._copiedT = setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove("copied");
    }, 1200);
  });
}

boot();
