import test from "node:test";
import assert from "node:assert/strict";

import {
  makePromptAction,
  type ModelRuntimeEventType,
  type AgentRunner,
  type CommandResult,
  type QueueStatus,
} from "../packages/core/runtime-protocol/src/index.ts";

type ExpectedCommandResult =
  | { readonly status: "handled" }
  | { readonly status: "not_found"; readonly command: string }
  | { readonly status: "blocked"; readonly command: string }
  | { readonly status: "exit_requested" }
  | { readonly status: "error"; readonly error: unknown };

const commandResultContract: CommandResult extends ExpectedCommandResult
  ? true
  : never = true;
const queueStatusContract: QueueStatus = {
  pending: 1,
  pendingTokens: 2,
  held: 3,
  heldTokens: 4,
  deadLetters: 5,
};
const runnerContract: AgentRunner | null = null;
const retryEventContract: ModelRuntimeEventType = "model_retry_scheduled";
void commandResultContract;
void queueStatusContract;
void runnerContract;
void retryEventContract;

test("session action factory preserves text and source", () => {
  const action = makePromptAction("hello", "composer");
  assert.equal(action.type, "prompt");
  assert.equal(action.text, "hello");
  assert.equal(action.source, "composer");
  assert.match(action.id, /^action_/);
});
