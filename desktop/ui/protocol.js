// ACP JSON-RPC helpers shared by the desktop client.
//
// Kept free of Tauri so Node can unit-test the wire-shape bugs that
// made 1.1.0 look like "I can't send chats":
//   - numeric vs string JSON-RPC ids never matching a pending request
//   - grok-desktop reverse-requests arriving as `_x.ai/…` (or wrapped)

"use strict";

/** Map key for a JSON-RPC id. Number `1` and string `"1"` must collide. */
export function rpcIdKey(id) {
  if (id === undefined || id === null) return "";
  return String(id);
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
