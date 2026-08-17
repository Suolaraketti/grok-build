import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rpcIdKey,
  rpcErrorText,
  friendlyRpcError,
  unwrapAgentRequest,
  isPermissionMethod,
  isFolderTrustMethod,
  isExitPlanMethod,
  isAskUserQuestionMethod,
  CLIENT_TYPE,
  CLIENT_IDENTIFIER,
  normalizeEffort,
  REASONING_EFFORT_META_KEY,
  unwrapExtResult,
} from "./protocol.js";

test("rpc ids coerce number and string to the same map key", () => {
  const pending = new Map();
  pending.set(rpcIdKey(1), "prompt");
  assert.equal(pending.get(rpcIdKey("1")), "prompt");
  assert.equal(pending.get(rpcIdKey(1)), "prompt");
});

test("unwraps _-prefixed ext methods", () => {
  const { method, params } = unwrapAgentRequest({
    method: "_x.ai/folder_trust/request",
    params: { cwd: "/repo", sessionId: "s" },
  });
  assert.equal(method, "x.ai/folder_trust/request");
  assert.equal(params.cwd, "/repo");
});

test("unwraps gateway-wrapped ext methods", () => {
  const { method, params } = unwrapAgentRequest({
    method: "_x.ai/ask_user_question",
    params: {
      method: "x.ai/ask_user_question",
      params: { sessionId: "s", questions: [] },
    },
  });
  assert.equal(method, "x.ai/ask_user_question");
  assert.equal(params.sessionId, "s");
});

test("classifies desktop reverse-request methods", () => {
  assert.equal(isPermissionMethod("session/request_permission"), true);
  assert.equal(isPermissionMethod("session/requestPermission"), true);
  assert.equal(isFolderTrustMethod("x.ai/folder_trust/request"), true);
  assert.equal(isExitPlanMethod("x.ai/exit_plan_mode"), true);
  assert.equal(isAskUserQuestionMethod("x.ai/ask_user_question"), true);
  assert.equal(isPermissionMethod("session/prompt"), false);
});

test("unwrapExtResult flattens official envelopes and surfaces error", () => {
  assert.deepEqual(unwrapExtResult({ result: { status: "queued" } }), { status: "queued" });
  assert.deepEqual(unwrapExtResult({ rewind_points: [] }), { rewind_points: [] });
  assert.throws(() => unwrapExtResult({ result: {}, error: "nope" }), /nope/);
});

test("reasoning effort normalizes official levels", () => {
  assert.equal(REASONING_EFFORT_META_KEY, "reasoningEffort");
  assert.equal(normalizeEffort("HIGH"), "high");
  assert.equal(normalizeEffort("xhigh"), "xhigh");
  assert.equal(normalizeEffort("nope"), "");
});

test("API identity is the shipping CLI, not waitlisted grok-desktop", () => {
  assert.equal(CLIENT_TYPE, "grok_desktop");
  assert.equal(CLIENT_IDENTIFIER, "grok-pager");
  assert.notEqual(CLIENT_IDENTIFIER, "grok-desktop");
});

test("rpcErrorText prefers data.message over Internal error", () => {
  assert.equal(
    rpcErrorText({
      message: "Internal error",
      data: {
        message: "API error (status 403 Forbidden): Grok Build is coming soon. You don't have access now.",
        http_status: 403,
      },
    }),
    "API error (status 403 Forbidden): Grok Build is coming soon. You don't have access now."
  );
  assert.equal(rpcErrorText({ message: "Internal error", data: "compact failed" }), "compact failed");
  assert.equal(rpcErrorText({ message: "Internal error" }), "Internal error");
});

test("friendlyRpcError rewrites the Grok Build waitlist 403", () => {
  const text = friendlyRpcError({
    message: "Internal error",
    data: {
      message: "API error (status 403 Forbidden): Grok Build is coming soon. You don't have access now.",
      http_status: 403,
    },
  });
  assert.match(text, /isn't enabled for this account/i);
  assert.match(text, /SuperGrok/);
  assert.doesNotMatch(text, /Internal error/);
});

test("friendlyRpcError still surfaces other 403 bodies", () => {
  const text = friendlyRpcError({
    message: "Internal error",
    data: {
      message: "API error (status 403 Forbidden): Access to the chat endpoint is denied",
      http_status: 403,
    },
  });
  assert.match(text, /Access to the chat endpoint is denied/);
  assert.match(text, /SuperGrok/);
});
