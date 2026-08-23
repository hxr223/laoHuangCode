import assert from "node:assert/strict";
import test from "node:test";

import {
  makeAnswerIntent,
  makeApprovalIntent,
  makeCancelIntent,
  makePromptIntent,
} from "../src/runtime/user-intent.ts";
import { routeHumanIntent } from "../src/runtime/human-intent-router.ts";
import {
  makeAnswerAction,
  makeApprovalAction,
  makeCancelAction,
  makeCommandAction,
  makePromptAction,
} from "../src/runtime/session-action-protocol.ts";
import { SessionState, AgentSession } from "../src/session.ts";

test("idle submit creates a prompt action", () => {
  const action = routeHumanIntent(
    makePromptIntent("explain this", "editor"),
    SessionState.Idle,
  );

  assert.deepEqual(
    { type: action.type, text: "text" in action ? action.text : undefined },
    { type: "prompt", text: "explain this" },
  );
});

test("slash text creates a command action", () => {
  const action = routeHumanIntent(
    makePromptIntent("/queue resume", "editor"),
    SessionState.Idle,
  );

  assert.deepEqual(
    {
      type: action.type,
      name: "name" in action ? action.name : undefined,
      arguments: "arguments" in action ? action.arguments : undefined,
    },
    { type: "command", name: "/queue", arguments: ["resume"] },
  );
});

test("keyboard cancellation creates a cancel action", () => {
  const action = routeHumanIntent(
    makeCancelIntent("keyboard", "editor"),
    SessionState.Running,
  );

  assert.deepEqual({
    type: action.type,
    reason: "reason" in action ? action.reason : undefined,
  }, { type: "cancel", reason: "keyboard" });
});

test("approval creates an approval action", () => {
  const action = routeHumanIntent(
    makeApprovalIntent("yes", "approval"),
    SessionState.Running,
  );

  assert.deepEqual(
    { type: action.type, text: "text" in action ? action.text : undefined },
    { type: "approval", text: "yes" },
  );
});

test("answer creates an answer action", () => {
  const action = routeHumanIntent(
    makeAnswerIntent("Tokyo", "question"),
    SessionState.Running,
  );

  assert.deepEqual(
    { type: action.type, text: "text" in action ? action.text : undefined },
    { type: "answer", text: "Tokyo" },
  );
});

test("submitAction delegates compatibility actions to existing session paths", async () => {
  const submitted: Array<{ content: string; strategy?: string }> = [];
  const session = new AgentSession(async (content) => {
    submitted.push({ content });
    return null;
  });
  const originalSubmitInput = session.submitInput.bind(session);
  session.submitInput = async (content, options = {}) => {
    submitted.push({ content, strategy: options.strategy });
    return originalSubmitInput(content, options);
  };

  await session.submitAction(makePromptAction("first", "editor"));
  await session.waitForIdle(1000);
  await session.submitAction(makeApprovalAction("yes", "approval"));
  await session.waitForIdle(1000);
  await session.submitAction(makeAnswerAction("Tokyo", "question"));
  await session.waitForIdle(1000);
  await session.submitAction(makeCommandAction("/queue", ["resume"]));
  await session.submitAction(makeCancelAction("keyboard", "editor"));

  assert.deepEqual(submitted, [
    { content: "first", strategy: undefined },
    { content: "first" },
    { content: "yes", strategy: "steer" },
    { content: "yes" },
    { content: "Tokyo", strategy: "follow_up" },
    { content: "Tokyo" },
    { content: "/queue resume", strategy: undefined },
  ]);
});
