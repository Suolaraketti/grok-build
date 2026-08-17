// ACP JSON-RPC helpers shared by the desktop client.
//
// Kept free of Tauri so Node can unit-test the wire-shape bugs that
// made 1.1.0 look like "I can't send chats":
//   - numeric vs string JSON-RPC ids never matching a pending request
//   - grok-desktop reverse-requests arriving as `_x.ai/…` (or wrapped)
//
// 1.1.2: do not send clientIdentifier "grok-desktop". The sampling proxy
// stamps that onto User-Agent / x-grok-client-identifier and waitlists the
// unreleased Electron product ("Grok Build is coming soon"). Keep
// clientType grok_desktop so the agent still sends Desktop reverse-requests.

"use strict";

export const DESKTOP_VERSION = "1.4.0";
export const CLIENT_INFO_NAME = "grok-build-desktop";

// Wire name the agent deserializes as ClientType::Desktop (underscore).
export const CLIENT_TYPE = "grok_desktop";

// Product token for User-Agent / x-grok-client-identifier. Must match the
// shipping CLI (`grok-pager`), not official grok-desktop (still gated).
export const CLIENT_IDENTIFIER = "grok-pager";

// Official ACP `_meta.reasoningEffort` (xai-grok-sampling-types).
export const REASONING_EFFORT_META_KEY = "reasoningEffort";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];

export function normalizeEffort(v) {
  const s = String(v || "").toLowerCase();
  return EFFORT_LEVELS.includes(s) ? s : "";
}

/** Flatten official ExtMethodResult `{ result, error? }` without dropping a lone payload. */
export function unwrapExtResult(result) {
  if (result == null) return {};
  if (typeof result !== "object" || Array.isArray(result)) return result;
  if (result.result === undefined) return result;
  const keys = Object.keys(result);
  if (!keys.every((k) => k === "result" || k === "error")) return result;
  if (result.error) {
    const err = new Error(String(result.error));
    err.data = result;
    throw err;
  }
  return result.result ?? {};
}

/** Map key for a JSON-RPC id. Number `1` and string `"1"` must collide. */
export function rpcIdKey(id) {
  if (id === undefined || id === null) return "";
  return String(id);
}

/**
 * Human-readable text from an ACP JSON-RPC error.
 *
 * `session/prompt` failures are `Error::internal_error()` — message is always
 * "Internal error" — with the real API text in `data` (string or `{message}`).
 */
export function rpcErrorText(err) {
  if (err == null) return "Unknown error";
  const data = err.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  }
  const msg = String(err.message || err).trim();
  return msg || "Unknown error";
}

/** Rewrite known agent/API failures into something a person can act on. */
export function friendlyRpcError(err) {
  const raw = rpcErrorText(err);
  const status = err && err.data && (err.data.http_status ?? err.data.httpStatus);
  const is403 = status === 403 || /status 403|\b403\b|forbidden/i.test(raw);
  const noAccess = /coming soon|don't have access now|do not have access|you don't have access/i.test(
    raw
  );
  if (is403 && noAccess) {
    return (
      "Grok Build isn't enabled for this account yet.\n\n" +
      "The coding agent is in beta for SuperGrok and X Premium+ subscribers — a free grok.com login is not enough.\n\n" +
      "If you already subscribe, sign out and back in. You can also paste an API key from console.x.ai."
    );
  }
  if (is403) {
    return `${raw}\n\nThis account doesn't have access to Grok Build. SuperGrok / X Premium+ (or an xAI API key) is required.`;
  }
  if (/^internal error$/i.test(raw)) {
    return "The agent hit an internal error. Try sending again; if it keeps happening, restart the app.";
  }
  if (/auth|401|unauthor/i.test(raw)) {
    return `${raw}\n\nYour session may have expired — sign out and back in from the account menu.`;
  }
  return raw;
}

/**
 * Normalize an agent-initiated JSON-RPC request.
 *
 * Stdio sends `_x.ai/foo` with the payload in `params`. Leader/gateway
 * wrapping nests `{ method: "x.ai/foo", params: {…} }` one level down.
 */
export function unwrapAgentRequest(msg) {
  let method = typeof msg?.method === "string" ? msg.method : "";
  let params = msg?.params ?? {};
  if (method.startsWith("_")) method = method.slice(1);

  if (
    params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.method === "string" &&
    params.params !== undefined
  ) {
    method = params.method.startsWith("_") ? params.method.slice(1) : params.method;
    params = params.params;
  }
  return { method, params };
}

export function isPermissionMethod(method) {
  return method === "session/request_permission" || method === "session/requestPermission";
}

export function isFolderTrustMethod(method) {
  return method === "x.ai/folder_trust/request";
}

export function isExitPlanMethod(method) {
  return method === "x.ai/exit_plan_mode";
}

export function isAskUserQuestionMethod(method) {
  return method === "x.ai/ask_user_question";
}
