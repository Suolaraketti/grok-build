// Grok Build Desktop — app wiring.
//
// One agent process serves the whole app; each chat in the sidebar is an ACP
// session (`session/new`) inside it. Streamed `session/update` notifications
// are routed to the owning chat's transcript by sessionId.

"use strict";

import { AgentClient, agentBinaryInfo, pickFolder, homeDir, openExternal } from "./acp.js";
import { renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);

const client = new AgentClient();

const state = {
  started: false,
  folder: "",
  model: "",
  alwaysApprove: false,
  chats: [], // {sessionId, title, el, turn, busy, titleEl}
  activeChat: null,
  stderrTail: [],
};

// ---------- status ----------

function setStatus(kind, text) {
  const dot = $("status-dot");
  dot.className = `dot dot-${kind}`;
  $("status-text").textContent = text;
}

// ---------- setup screen ----------

async function initSetup() {
  const info = await agentBinaryInfo();
  if (!info.binary) {
    const warn = $("binary-warning");
    warn.classList.remove("hidden");
    warn.textContent =
      "The grok agent binary was not found. Install the Grok CLI from " +
      "x.ai/cli (or set GROK_DESKTOP_AGENT_BIN to a build of " +
      "xai-grok-pager), then press Start.";
  }
  const home = await homeDir();
  if (home && !$("setup-folder").value) $("setup-folder").value = home;
}

$("setup-browse").addEventListener("click", async () => {
  const picked = await pickFolder();
  if (picked) $("setup-folder").value = picked;
});

$("setup-start").addEventListener("click", startAgent);

async function startAgent() {
  const btn = $("setup-start");
  btn.disabled = true;
  btn.textContent = "Starting…";
  state.folder = $("setup-folder").value.trim();
  state.model = $("setup-model").value.trim();
  state.alwaysApprove = $("setup-yolo").checked;

  try {
    await client.start({
      model: state.model || null,
      alwaysApprove: state.alwaysApprove,
    });
    state.started = true;
    setStatus("on", "agent ready");
    $("folder-label").textContent = state.folder || "no folder";
    $("model-label").textContent = state.model || "default model";
    $("setup").classList.add("hidden");
    $("chat-area").classList.remove("hidden");
    if (!state.chats.length) await newChat();
    else $("prompt-input").focus();
  } catch (err) {
    setStatus("off", "agent failed to start");
    const warn = $("binary-warning");
    warn.classList.remove("hidden");
    warn.textContent = `Could not start the agent: ${err.message || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Start";
  }
}

$("settings-btn").addEventListener("click", () => {
  $("chat-area").classList.add("hidden");
  $("setup").classList.remove("hidden");
});

$("folder-btn").addEventListener("click", async () => {
  const picked = await pickFolder();
  if (picked) {
    state.folder = picked;
    $("folder-label").textContent = picked;
    $("setup-folder").value = picked;
  }
});

// ---------- chats ----------

async function newChat() {
  if (!state.started) return;
  let session;
  try {
    session = await client.newSession(state.folder || ".");
  } catch (err) {
    showGlobalError(err);
    return;
  }

  const el = document.createElement("div");
  el.className = "transcript";
  $("transcripts").appendChild(el);

  const chat = {
    sessionId: session.sessionId,
    title: "New chat",
    el,
    turn: null,
    busy: false,
    titleEl: null,
  };

  const item = document.createElement("div");
  item.className = "chat-item";
  item.textContent = chat.title;
  item.addEventListener("click", () => switchChat(chat));
  $("chat-list").prepend(item);
  chat.titleEl = item;

  state.chats.push(chat);
  switchChat(chat);
}

function switchChat(chat) {
  state.activeChat = chat;
  for (const c of state.chats) {
    c.el.style.display = c === chat ? "" : "none";
    c.titleEl.classList.toggle("active", c === chat);
  }
  updateComposer();
  $("prompt-input").focus();
}

function chatBySession(sessionId) {
  return state.chats.find((c) => c.sessionId === sessionId);
}

$("new-chat").addEventListener("click", () => {
  if (state.started) newChat();
});

// Errors that aren't tied to a chat (e.g. session/new failed).
function showGlobalError(err) {
  const warn = $("binary-warning");
  warn.classList.remove("hidden");
  warn.textContent = friendlyError(err);
  $("chat-area").classList.add("hidden");
  $("setup").classList.remove("hidden");
}

function friendlyError(err) {
  const msg = String((err && err.message) || err);
  if (/auth/i.test(msg) || err?.code === -32000) {
    return (
      `${msg}\n\nIt looks like the agent isn't signed in. Run "grok login" ` +
      `in a terminal (or set XAI_API_KEY), then try again.`
    );
  }
  return msg;
}

// ---------- transcript rendering ----------

function scrollToBottom(chat) {
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
  scrollToBottom(chat);
}

function beginTurn(chat) {
  const container = document.createElement("div");
  container.className = "msg msg-agent";
  chat.el.appendChild(container);

  const spinner = document.createElement("div");
  spinner.className = "turn-spinner";
  spinner.textContent = "Working…";
  container.appendChild(spinner);

  chat.turn = {
    container,
    spinner,
    mdDiv: null,
    textBuf: "",
    thoughtEl: null,
    thoughtBody: "",
    toolCards: new Map(), // toolCallId -> {statusEl, titleEl}
    planEl: null,
  };
}

function endTurn(chat) {
  if (chat.turn?.spinner) chat.turn.spinner.remove();
  chat.turn = null;
  chat.busy = false;
  updateComposer();
}

// Close the current streaming text block so later chunks start a new one
// (keeps text/tool-call ordering readable).
function sealTextBlock(turn) {
  turn.mdDiv = null;
  turn.textBuf = "";
}

function sealThought(turn) {
  turn.thoughtEl = null;
  turn.thoughtBody = "";
}

function contentText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (content.type === "text") return content.text ?? "";
  return "";
}

function handleUpdate(params) {
  const chat = chatBySession(params.sessionId);
  if (!chat) return;
  if (!chat.turn) beginTurn(chat); // update outside a prompt (e.g. resumed work)
  const turn = chat.turn;
  const update = params.update ?? {};

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
        details.innerHTML =
          '<summary>Thinking…</summary><div class="thought-body"></div>';
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
      const entries = (update.entries || [])
        .map((e) => {
          const cls = ["pending", "in_progress", "completed"].includes(e.status)
            ? e.status
            : "pending";
          const mark = cls === "completed" ? "☑" : cls === "in_progress" ? "▸" : "☐";
          const div = `<div class="plan-entry ${cls}"><span>${mark}</span><span></span></div>`;
          return { div, text: contentText(e.content) || String(e.content ?? "") };
        });
      turn.planEl.innerHTML = '<div class="plan-title">Plan</div>';
      for (const e of entries) {
        const tpl = document.createElement("template");
        tpl.innerHTML = e.div;
        tpl.content.firstChild.lastChild.textContent = e.text;
        turn.planEl.appendChild(tpl.content.firstChild);
      }
      break;
    }
    default:
      break; // unknown update kinds are ignored
  }
  scrollToBottom(chat);
}

client.onSessionUpdate = handleUpdate;

// ---------- permission requests ----------

client.onPermissionRequest = (params) =>
  new Promise((resolve) => {
    const overlay = $("perm-overlay");
    const body = $("perm-body");
    const optionsBox = $("perm-options");
    body.textContent = "";
    optionsBox.textContent = "";

    const tool = params.toolCall || {};
    const toolLine = document.createElement("div");
    toolLine.className = "perm-tool";
    toolLine.textContent = tool.title || "The agent wants to run a tool.";
    body.appendChild(toolLine);

    const rawInput = tool.rawInput ?? tool.input;
    if (rawInput !== undefined) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      try {
        code.textContent = JSON.stringify(rawInput, null, 2);
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
      btn.addEventListener("click", () =>
        finish({ outcome: "selected", optionId: opt.optionId })
      );
      optionsBox.appendChild(btn);
    }

    overlay.classList.remove("hidden");
  });

// ---------- composer ----------

function updateComposer() {
  const busy = !!state.activeChat?.busy;
  $("send-btn").classList.toggle("hidden", busy);
  $("stop-btn").classList.toggle("hidden", !busy);
  $("prompt-input").disabled = false;
}

async function sendPrompt() {
  const input = $("prompt-input");
  const text = input.value.trim();
  const chat = state.activeChat;
  if (!text || !chat || chat.busy || !state.started) return;

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
  setStatus("busy", "agent working");

  try {
    await client.prompt(chat.sessionId, text);
  } catch (err) {
    const note = document.createElement("div");
    note.className = "error-note";
    note.textContent = friendlyError(err);
    (chat.turn?.container || chat.el).appendChild(note);
  } finally {
    endTurn(chat);
    if (state.started) setStatus("on", "agent ready");
    scrollToBottom(chat);
  }
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
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

// ---------- agent lifecycle ----------

client.onExit = () => {
  state.started = false;
  setStatus("off", "agent exited");
  for (const chat of state.chats) {
    if (chat.busy) endTurn(chat);
  }
  const active = state.activeChat;
  if (active) {
    const note = document.createElement("div");
    note.className = "error-note";
    note.textContent =
      "The agent process exited." +
      (state.stderrTail.length ? `\n\n${state.stderrTail.join("\n")}` : "") +
      "\n\nOpen Settings and press Start to relaunch it.";
    active.el.appendChild(note);
    scrollToBottom(active);
  }
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

initSetup();
