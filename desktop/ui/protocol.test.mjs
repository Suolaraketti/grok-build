import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rpcIdKey,
  unwrapAgentRequest,
  isPermissionMethod,
  isFolderTrustMethod,
  isExitPlanMethod,
  isAskUserQuestionMethod,
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
