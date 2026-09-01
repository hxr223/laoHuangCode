import assert from "node:assert/strict";
import test from "node:test";

import {
  makeAnswerIntent,
  makeApprovalIntent,
  makeCancelIntent,
  makeFollowUpIntent,
  makePromptIntent,
  makeSteerIntent,
} from "../packages/core/runtime-protocol/src/index.ts";
import { routeHumanIntent } from "../packages/session/session-runtime/src/index.ts";
import {
  makeAnswerAction,
  makeApprovalAction,
  makeCancelAction,
  makeCommandAction,
  makePromptAction,
} from "../packages/core/runtime-protocol/src/index.ts";
import { SessionState, AgentSession } from "../packages/session/session-runtime/src/index.ts";

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
      text: "text" in action ? action.text : undefined,
    },
    {
      type: "command",
      name: "/queue",
      arguments: ["resume"],
      text: "/queue resume",
    },
  );
});

test("slash text preserves quoted command arguments", () => {
  const action = routeHumanIntent(
    makePromptIntent('/cmd "two words"', "editor"),
    SessionState.Idle,
  );

  assert.deepEqual(
    {
      type: action.type,
      arguments: "arguments" in action ? action.arguments : undefined,
      text: "text" in action ? action.text : undefined,
    },
    {
      type: "command",
      arguments: ["two words"],
      text: '/cmd "two words"',
    },
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

test("ordinary prompt action leaves semantic routing unresolved", () => {
  const action = routeHumanIntent(
    makePromptIntent("classify this", "editor"),
    SessionState.Running,
  );

  assert.deepEqual(
    { type: action.type, text: "text" in action ? action.text : undefined },
    { type: "prompt", text: "classify this" },
  );
});

test("follow-up intent creates an explicit follow-up action", () => {
  const action = routeHumanIntent(
    makeFollowUpIntent("next", "editor"),
    SessionState.Running,
  );

  assert.deepEqual(
    { type: action.type, text: "text" in action ? action.text : undefined },
    { type: "follow_up", text: "next" },
  );
});

test("steer intent creates an explicit steer action", () => {
  const action = routeHumanIntent(
    makeSteerIntent("now", "editor"),
    SessionState.Running,
  );

  assert.deepEqual(
    { type: action.type, text: "text" in action ? action.text : undefined },
    { type: "steer", text: "now" },
  );
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
  await session.submitAction(makeCancelAction("keyboard", "editor"));

  assert.deepEqual(submitted, [
    { content: "first", strategy: undefined },
    { content: "first" },
    { content: "yes", strategy: "steer" },
    { content: "yes" },
    { content: "Tokyo", strategy: "follow_up" },
    { content: "Tokyo" },
  ]);
});

test("submitAction dispatches raw command text through its command entry", async () => {
  const commands: string[] = [];
  const session = new AgentSession(() => null, {
    commandDispatcher: async (command) => {
      commands.push(command);
      return true;
    },
  });
  const action = routeHumanIntent(
    makePromptIntent('/cmd "two words"', "editor"),
    SessionState.Idle,
  );

  await session.submitAction(action);

  assert.deepEqual(commands, ['/cmd "two words"']);
});
