// Grok Build Desktop — app wiring.
//
// Screens: boot → signin → authing → app. One agent process serves the whole
// app; each chat is an ACP session (`session/new`) inside it. Auth uses the
// agent's `x.ai/auth/*` extension so users sign in with their Grok account
// (browser OAuth) or an API key, without ever touching a terminal.

"use strict";

import { AgentClient, METHOD, agentBinaryInfo, pickFolder, homeDir, openExternal } from "./acp.js";
import { renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const client = new AgentClient();

const state = {
  folder: "",
  model: "",
  alwaysApprove: false,
  account: null, // { email, name, avatar, sub }
  chats: [],
  activeChat: null,
  stderrTail: [],
  authSeq: 0, // guards stale auth attempts
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

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2200);
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
    await client.start({ model: state.model || null, alwaysApprove: state.alwaysApprove });
  } catch (err) {
    show("signin");
    signinError(`Couldn't start the agent: ${err.message || err}`);
    return;
  }

  // Already authenticated? cached_token / xai.api_key are only advertised when
  // valid credentials exist, so activating them never opens a browser.
  const silent = client.hasAuthMethod(METHOD.CACHED_TOKEN)
    ? METHOD.CACHED_TOKEN
    : client.hasAuthMethod(METHOD.API_KEY)
    ? METHOD.API_KEY
    : null;

  if (silent) {
    $("boot-text").textContent = "Signing you in…";
    try {
      await client.authenticate(silent, {});
      await enterApp();
      return;
    } catch {
      // fall through to the sign-in screen
    }
  }

  presentSignin();
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
    // No interactive method (e.g. admin-pinned API-key auth): hide OAuth.
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

// Shape the authenticating screen to the login mode reported by get_url.
function applyAuthUrl(info) {
  const url = info.auth_url || info.authUrl || null;
  const mode = info.mode || (info.external_provider ? "command" : "loopback");

  if (url) {
    $("authing-open").dataset.url = url;
    $("authing-open").classList.remove("hidden");
    $("authing-url").textContent = url;
  }

  if (mode === "device") {
    // The URL often carries the user code; show it prominently.
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
    // loopback — automatic, with a manual paste fallback.
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
  state.authSeq++; // invalidate the in-flight attempt
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
  if (!state.folder) {
    const home = await homeDir();
    state.folder = home || ".";
  }
  updateFolderLabel();
  updateModelLabel();
  populateSuggestions();
  if (!state.chats.length) await newChat();
  updateEmptyState();
  $("prompt-input").focus();
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
    (client.binaryPath ? "Signed in" : "Signed in");
  const sub = info.teamName || info.email || "";
  state.account = {
    email: info.email || null,
    name,
    sub,
    avatar: info.profileImageUrl || null,
  };
  $("account-name").textContent = name;
  $("account-sub").textContent = sub && sub !== name ? sub : "";
  // Initials avatar — remote profile images are either grok-asset:// (Electron
  // only) or blocked by the app's img-src CSP, so we don't fetch them.
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
  // Reset app state and go back to sign-in.
  state.chats = [];
  state.activeChat = null;
  $("transcripts").textContent = "";
  $("chat-list").textContent = "";
  presentSignin();
});

// ============================ SETTINGS ============================

function openSettings() {
  $("set-yolo").checked = state.alwaysApprove;
  $("set-model").value = state.model;
  $("settings-overlay").classList.remove("hidden");
}
$("settings-close").addEventListener("click", () => {
  state.alwaysApprove = $("set-yolo").checked;
  state.model = $("set-model").value.trim();
  updateModelLabel();
  $("settings-overlay").classList.add("hidden");
});

// ============================ FOLDER ============================

async function chooseFolder() {
  const picked = await pickFolder();
  if (picked) {
    state.folder = picked;
    updateFolderLabel();
  }
}
$("folder-btn").addEventListener("click", chooseFolder);
$("empty-open-folder").addEventListener("click", chooseFolder);

function updateFolderLabel() {
  const f = state.folder;
  const short = f ? f.split("/").filter(Boolean).slice(-2).join("/") || f : "Open a folder";
  $("folder-label").textContent = short;
  $("folder-btn").title = f || "Open a folder";
}

function updateModelLabel() {
  $("model-label").textContent = state.model || "Default model";
}

// ============================ CHATS ============================

async function newChat() {
  let session;
  try {
    session = await client.newSession(state.folder || ".");
  } catch (err) {
    toast(`Couldn't start a chat: ${err.message || err}`);
    return;
  }

  const el = document.createElement("div");
  el.className = "transcript";
  $("transcripts").appendChild(el);

  const item = document.createElement("div");
  item.className = "chat-item";
  item.textContent = "New chat";

  const chat = {
    sessionId: session.sessionId,
    title: "New chat",
    el,
    titleEl: item,
    turn: null,
    busy: false,
  };
  item.addEventListener("click", () => switchChat(chat));
  $("chat-list").prepend(item);
  state.chats.push(chat);
  switchChat(chat);
  updateEmptyState();
}

function switchChat(chat) {
  state.activeChat = chat;
  for (const c of state.chats) {
    c.el.style.display = c === chat ? "" : "none";
    c.titleEl.classList.toggle("active", c === chat);
  }
  updateComposer();
  updateEmptyState();
  $("prompt-input").focus();
}

function chatBySession(sessionId) {
  return state.chats.find((c) => c.sessionId === sessionId);
}

$("new-chat").addEventListener("click", newChat);

function updateEmptyState() {
  const chat = state.activeChat;
  const empty = chat && chat.el.childElementCount === 0;
  $("empty-state").classList.toggle("hidden", !empty);
  $("empty-folder-cta").classList.add("hidden"); // folder always has a default
}

// ============================ TRANSCRIPT RENDERING ============================

function scrollToBottom() {
  const box = $("transcripts");
  box.scrollTop = box.scrollHeight;
}

function addUserMessage(chat, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  chat.el.appendChild(wrap);
  updateEmptyState();
  scrollToBottom();
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
    mdDiv: null,
    textBuf: "",
    thoughtEl: null,
    thoughtBody: "",
    toolCards: new Map(),
    planEl: null,
  };
}

function endTurn(chat) {
  if (chat.turn?.spinner) chat.turn.spinner.remove();
  chat.turn = null;
  chat.busy = false;
  updateComposer();
}

function sealTextBlock(turn) { turn.mdDiv = null; turn.textBuf = ""; }
function sealThought(turn) { turn.thoughtEl = null; turn.thoughtBody = ""; }

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text ?? "";
  return "";
}

const TURN_CONTENT = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
]);

function handleUpdate(params) {
  const chat = chatBySession(params.sessionId);
  if (!chat) return;
  const update = params.update ?? {};

  // The agent also emits non-turn notifications (available commands, mode,
  // etc.). Only actual turn content should open a turn and show the spinner.
  if (!TURN_CONTENT.has(update.sessionUpdate)) return;

  // Content arriving outside a prompt we initiated gets no "Working…" spinner.
  if (!chat.turn) beginTurn(chat, chat.busy);
  const turn = chat.turn;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      sealThought(turn);
      if (!turn.mdDiv) {
        turn.mdDiv = document.createElement("div");
        turn.mdDiv.className = "md";
        turn.container.insertBefore(turn.mdDiv, turn.spinner);
      }
      turn.textBuf += contentText(update.content);
      turn.mdDiv.innerHTML = renderMarkdown(turn.textBuf);
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
      const card = document.createElement("div");
      card.className = "tool-call";
      const status = document.createElement("span");
      status.className = `tool-status ${update.status || "pending"}`;
      const title = document.createElement("span");
      title.className = "tool-title";
      const kind = document.createElement("span");
      kind.className = "tool-kind";
      kind.textContent = update.kind || "tool";
      title.appendChild(kind);
      title.appendChild(document.createTextNode(update.title || ""));
      card.appendChild(status);
      card.appendChild(title);
      turn.container.insertBefore(card, turn.spinner);
      if (update.toolCallId) {
        turn.toolCards.set(update.toolCallId, { statusEl: status, titleEl: title, kindEl: kind });
      }
      break;
    }
    case "tool_call_update": {
      const card = turn.toolCards.get(update.toolCallId);
      if (card) {
        if (update.status) card.statusEl.className = `tool-status ${update.status}`;
        if (update.title) {
          card.titleEl.textContent = "";
          card.titleEl.appendChild(card.kindEl);
          card.titleEl.appendChild(document.createTextNode(update.title));
        }
      }
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
  scrollToBottom();
}

client.onSessionUpdate = handleUpdate;

// ============================ PERMISSIONS ============================

client.onPermissionRequest = (params) =>
  new Promise((resolve) => {
    const overlay = $("perm-overlay");
    const body = $("perm-body");
    const optionsBox = $("perm-options");
    body.textContent = "";
    optionsBox.textContent = "";

    const tool = params.toolCall || {};
    $("perm-title").textContent = tool.title || "Grok wants to run an action";

    const rawInput = tool.rawInput ?? tool.input;
    if (rawInput !== undefined) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      try {
        code.textContent = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput, null, 2);
      } catch {
        code.textContent = String(rawInput);
      }
      pre.appendChild(code);
      body.appendChild(pre);
    }

    const finish = (outcome) => {
      overlay.classList.add("hidden");
      resolve(outcome);
    };

    for (const opt of params.options || []) {
      const btn = document.createElement("button");
      const isAllow = /allow/.test(opt.kind || "");
      btn.className = isAllow ? "btn btn-primary" : "btn";
      btn.textContent = opt.name || opt.optionId;
      btn.addEventListener("click", () => finish({ outcome: "selected", optionId: opt.optionId }));
      optionsBox.appendChild(btn);
    }
    if (!(params.options || []).length) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Cancel";
      btn.addEventListener("click", () => finish({ outcome: "cancelled" }));
      optionsBox.appendChild(btn);
    }

    overlay.classList.remove("hidden");
  });

// ============================ COMPOSER ============================

function updateComposer() {
  const busy = !!state.activeChat?.busy;
  $("send-btn").classList.toggle("hidden", busy);
  $("stop-btn").classList.toggle("hidden", !busy);
}

async function sendPrompt() {
  const input = $("prompt-input");
  const text = input.value.trim();
  const chat = state.activeChat;
  if (!text || !chat || chat.busy) return;

  input.value = "";
  autosize(input);

  if (chat.title === "New chat") {
    chat.title = text.length > 42 ? `${text.slice(0, 42)}…` : text;
    chat.titleEl.textContent = chat.title;
  }

  addUserMessage(chat, text);
  beginTurn(chat);
  chat.busy = true;
  updateComposer();

  try {
    await client.prompt(chat.sessionId, text);
  } catch (err) {
    const note = document.createElement("div");
    note.className = "error-note";
    note.textContent = friendlyError(err);
    (chat.turn?.container || chat.el).appendChild(note);
  } finally {
    endTurn(chat);
    scrollToBottom();
  }
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/auth|401|unauthor/i.test(msg)) {
    return `${msg}\n\nYour session may have expired — sign out and back in from the account menu.`;
  }
  return msg;
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
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
$("prompt-input").addEventListener("input", (e) => autosize(e.target));

// ============================ MODEL MENU (placeholder single) ============================

$("model-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openSettings(); // model is edited in settings for now
});

// ============================ AGENT LIFECYCLE ============================

client.onExit = () => {
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
    scrollToBottom();
  }
  toast("Agent stopped");
};

client.onStderr = (line) => {
  state.stderrTail.push(line);
  if (state.stderrTail.length > 8) state.stderrTail.shift();
};

// External links from markdown open in the system browser.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-external]");
  if (a) {
    e.preventDefault();
    openExternal(a.getAttribute("href")).catch(() => {});
  }
});

boot();
