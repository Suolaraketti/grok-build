// TUI-parity panels: Extensions studio + session inspector.
// Talks to official x.ai/* ACP methods. Kept out of main.js so the chat
// surface stays readable.

"use strict";

let ctx = null;
let studioTab = "skills";

export function initStudio(next) {
  ctx = next;
  applyTheme(ctx.getPrefs().theme);
  $("studio-close")?.addEventListener("click", closeStudio);
  $("studio-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("studio-overlay")) closeStudio();
  });
  for (const btn of document.querySelectorAll("#studio-tabs [data-tab]")) {
    btn.addEventListener("click", () => openStudio(btn.dataset.tab));
  }
  $("inspect-btn")?.addEventListener("click", toggleInspector);
  $("studio-btn")?.addEventListener("click", () => openStudio("skills"));
  $("docs-btn")?.addEventListener("click", () => {
    ctx.openExternal("https://docs.x.ai/build/overview").catch(() => {});
  });
}

export function applyTheme(theme) {
  const t = theme === "light" || theme === "dark" ? theme : "system";
  document.documentElement.dataset.theme = t;
  if (ctx) ctx.setPref("theme", t);
}

export function openStudio(tab) {
  studioTab = tab || studioTab || "skills";
  $("studio-overlay").classList.remove("hidden");
  for (const btn of document.querySelectorAll("#studio-tabs [data-tab]")) {
    btn.classList.toggle("active", btn.dataset.tab === studioTab);
  }
  loadStudio();
}

export function closeStudio() {
  $("studio-overlay")?.classList.add("hidden");
}

export function toggleInspector() {
  const rail = $("right-rail");
  const hidden = rail.classList.toggle("hidden");
  rail.hidden = hidden;
  $("inspect-btn")?.classList.toggle("active", !hidden);
  if (!hidden) refreshInspector();
}

export async function refreshInspector() {
  const box = $("inspector-body");
  if (!box || $("right-rail").classList.contains("hidden")) return;
  const chat = ctx.getState().activeChat;
  if (!chat?.sessionId) {
    box.textContent = "";
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Open a chat to see session info, context, and subagents.";
    box.appendChild(p);
    return;
  }
  box.textContent = "";
  box.appendChild(h("p", "muted small", "Loading…"));

  const [info, usage, agents, trees, stateCol] = await Promise.allSettled([
    ctx.client.sessionInfo(chat.sessionId),
    ctx.client.sessionUsage(chat.sessionId),
    ctx.client.listSubagents(chat.sessionId),
    ctx.client.listWorktrees(),
    ctx.client.sessionState(chat.sessionId, chat.folder),
  ]);

  box.textContent = "";
  const infoVal = ok(info);
  const usageVal = ok(usage);
  const agentsVal = ok(agents);
  const treesVal = ok(trees);
  const stateVal = ok(stateCol);

  box.appendChild(section("Session", renderSession(infoVal, chat)));
  box.appendChild(section("Context", renderContext(infoVal, usageVal)));
  box.appendChild(section("Subagents", renderSubagents(agentsVal)));
  box.appendChild(section("Worktrees", renderWorktrees(treesVal)));
  if (stateVal?.plan || stateVal?.goal) {
    box.appendChild(section("Plan / goal", renderPlan(stateVal)));
  }
}

function $(id) {
  return document.getElementById(id);
}

function ok(settled) {
  return settled.status === "fulfilled" ? settled.value : null;
}

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function section(title, body) {
  const wrap = document.createElement("div");
  wrap.className = "insp-sec";
  wrap.appendChild(h("h3", "", title));
  wrap.appendChild(body);
  return wrap;
}

function kv(label, value) {
  const row = document.createElement("div");
  row.className = "insp-kv";
  row.appendChild(h("span", "k", label));
  row.appendChild(h("span", "v", value == null || value === "" ? "—" : String(value)));
  return row;
}

function renderSession(info, chat) {
  const box = document.createElement("div");
  const i = info || {};
  box.appendChild(kv("Title", chat.title));
  box.appendChild(kv("Model", i.modelDisplayName || i.model || chat.models?.currentModelId));
  box.appendChild(kv("Agent", i.agentName));
  box.appendChild(kv("Turns", i.turns ?? i.turnIndex));
  box.appendChild(kv("Folder", i.cwd || chat.folder));
  return box;
}

function renderContext(info, usage) {
  const box = document.createElement("div");
  const ctxu = info?.context || {};
  const used = ctxu.used ?? ctxu.usage;
  const total = ctxu.total;
  const pct = ctxu.usagePct ?? (used && total ? Math.round((used / total) * 100) : null);
  if (pct != null) {
    const bar = document.createElement("div");
    bar.className = "credit-bar";
    const fill = document.createElement("div");
    fill.style.width = `${Math.min(100, pct)}%`;
    if (pct >= 85) fill.className = "hot";
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(kv("Window", `${pct}%${ctxu.autoCompactThresholdPercent ? ` · compact at ${ctxu.autoCompactThresholdPercent}%` : ""}`));
  }
  const u = usage?.usage || usage || {};
  if (u.inputTokens != null || u.outputTokens != null) {
    box.appendChild(kv("Tokens in / out", `${u.inputTokens ?? "—"} / ${u.outputTokens ?? "—"}`));
  }
  if (!box.childElementCount) box.appendChild(h("p", "muted small", "No context data from this agent."));
  return box;
}

function renderSubagents(data) {
  const list = data?.subagents || data?.result?.subagents || [];
  const box = document.createElement("div");
  if (!list.length) {
    box.appendChild(h("p", "muted small", "No running subagents."));
    return box;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const title = s.description || s.subagentType || s.subagentId;
    row.appendChild(h("div", "insp-name", title));
    row.appendChild(h("div", "muted small", `${s.subagentType || "subagent"} · ${s.status || "running"}`));
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn";
    stop.textContent = "Stop";
    stop.addEventListener("click", async () => {
      try {
        await ctx.client.cancelSubagent(s.subagentId);
        ctx.toast("Stopped subagent");
        refreshInspector();
      } catch (err) {
        ctx.toast(ctx.friendlyRpcError(err));
      }
    });
    row.appendChild(stop);
    box.appendChild(row);
  }
  return box;
}

function renderWorktrees(data) {
  const list = data?.worktrees || data?.result?.worktrees || data?.items || [];
  const box = document.createElement("div");
  if (!Array.isArray(list) || !list.length) {
    box.appendChild(h("p", "muted small", "No tracked worktrees. Create one from the terminal with grok --worktree."));
    return box;
  }
  for (const w of list) {
    const path = w.path || w.worktreePath || w.idOrPath || w.id || "";
    box.appendChild(kv(w.label || w.worktreeType || "worktree", path));
  }
  return box;
}

function renderPlan(state) {
  const box = document.createElement("div");
  const plan = state.plan || state.planMode;
  const text = typeof plan === "string" ? plan : plan?.content || plan?.plan || JSON.stringify(plan, null, 2);
  const pre = h("pre", "perm-pre", typeof text === "string" ? text.slice(0, 4000) : "");
  box.appendChild(pre);
  if (state.goal) {
    const g = state.goal.objective || state.goal.status || JSON.stringify(state.goal);
    box.appendChild(kv("Goal", typeof g === "string" ? g : JSON.stringify(g)));
  }
  return box;
}

async function loadStudio() {
  const body = $("studio-body");
  body.textContent = "";
  body.appendChild(h("p", "muted small", "Loading…"));
  try {
    if (studioTab === "skills") await renderSkills(body);
    else if (studioTab === "mcp") await renderMcp(body);
    else if (studioTab === "plugins") await renderPlugins(body);
    else if (studioTab === "hooks") await renderHooks(body);
  } catch (err) {
    body.textContent = "";
    body.appendChild(h("p", "muted", ctx.friendlyRpcError(err)));
  }
}

function row(name, meta, onToggle, enabled) {
  const el = document.createElement("div");
  el.className = "studio-row";
  const left = document.createElement("div");
  left.appendChild(h("div", "studio-name", name));
  if (meta) left.appendChild(h("div", "muted small", meta));
  el.appendChild(left);
  if (onToggle) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = enabled ? "Disable" : "Enable";
    btn.addEventListener("click", onToggle);
    el.appendChild(btn);
  }
  return el;
}

async function renderSkills(body) {
  const cwd = ctx.getState().folder || ctx.getState().activeChat?.folder || ".";
  const data = await ctx.client.listSkills(cwd);
  const skills = data.skills || [];
  body.textContent = "";
  body.appendChild(h("p", "muted small", `${skills.length} skill${skills.length === 1 ? "" : "s"} from ~/.grok and this project.`));
  if (!skills.length) {
    body.appendChild(h("p", "muted", "No skills discovered. Add SKILL.md packages under ~/.grok/skills."));
    return;
  }
  for (const s of skills) {
    const enabled = s.enabled !== false && s.disabled !== true;
    body.appendChild(
      row(s.name || s.id, [s.source || s.scope, s.description].filter(Boolean).join(" · "), async () => {
        try {
          await ctx.client.toggleSkill(s.name, !enabled, cwd);
          ctx.toast(`${s.name} ${enabled ? "disabled" : "enabled"}`);
          loadStudio();
        } catch (err) {
          ctx.toast(ctx.friendlyRpcError(err));
        }
      }, enabled)
    );
  }
}

async function renderMcp(body) {
  const sid = ctx.getState().activeChat?.sessionId;
  const data = await ctx.client.listMcp(sid);
  const servers = data.servers || [];
  body.textContent = "";
  body.appendChild(h("p", "muted small", "MCP servers from ~/.grok/config.toml and trusted project config."));
  if (!servers.length) {
    body.appendChild(h("p", "muted", "No MCP servers. Add [mcp_servers.name] in ~/.grok/config.toml, or grok mcp add."));
    return;
  }
  for (const s of servers) {
    const enabled = s.session?.enabled !== false && s.enabled !== false;
    const meta = [s.source, s.config?.type || s.type, s.session?.status].filter(Boolean).join(" · ");
    body.appendChild(
      row(s.displayName || s.name, meta, sid ? async () => {
        try {
          await ctx.client.toggleMcp(sid, s.name, !enabled);
          ctx.toast(`${s.name} ${enabled ? "disabled" : "enabled"}`);
          loadStudio();
        } catch (err) {
          ctx.toast(ctx.friendlyRpcError(err));
        }
      } : null, enabled)
    );
  }
}

async function renderPlugins(body) {
  const sid = ctx.getState().activeChat?.sessionId;
  const data = await ctx.client.listPlugins(sid);
  const plugins = data.plugins || [];
  body.textContent = "";
  body.appendChild(h("p", "muted small", "Plugins bundle skills, hooks, and MCP servers."));
  if (!plugins.length) {
    body.appendChild(h("p", "muted", "No plugins installed. Use grok plugin install, or /plugins in the TUI marketplace."));
    return;
  }
  for (const p of plugins) {
    const enabled = p.enabled !== false;
    const meta = [p.scope, p.version, p.trusted ? "trusted" : "untrusted", p.description].filter(Boolean).join(" · ");
    body.appendChild(
      row(p.name || p.id, meta, sid ? async () => {
        try {
          await ctx.client.pluginAction(sid, {
            type: enabled ? "disable" : "enable",
            plugin_id: p.id || p.name,
          });
          ctx.toast(`${p.name} ${enabled ? "disabled" : "enabled"}`);
          loadStudio();
        } catch (err) {
          ctx.toast(ctx.friendlyRpcError(err));
        }
      } : null, enabled)
    );
  }
}

async function renderHooks(body) {
  const sid = ctx.getState().activeChat?.sessionId;
  const data = await ctx.client.listHooks(sid);
  const hooks = data.hooks || [];
  body.textContent = "";
  const trust = data.projectTrusted ? "Project hooks are trusted." : "Project hooks need folder trust.";
  body.appendChild(h("p", "muted small", trust));
  if (!hooks.length) {
    body.appendChild(h("p", "muted", "No hooks loaded."));
    return;
  }
  for (const hk of hooks) {
    const enabled = !hk.disabled;
    const meta = [hk.event, hk.handlerType || hk.handler_type, hk.matcher].filter(Boolean).join(" · ");
    body.appendChild(
      row(hk.name, meta, sid ? async () => {
        try {
          await ctx.client.hookAction(sid, {
            type: enabled ? "disable" : "enable",
            hookName: hk.name,
          });
          ctx.toast(`${hk.name} ${enabled ? "disabled" : "enabled"}`);
          loadStudio();
        } catch (err) {
          ctx.toast(ctx.friendlyRpcError(err));
        }
      } : null, enabled)
    );
  }
}
