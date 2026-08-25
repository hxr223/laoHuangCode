import test from "node:test";
import assert from "node:assert/strict";

import { makePromptAction } from "../src/core/session-action-protocol.ts";

test("session action factory preserves text and source", () => {
  const action = makePromptAction("hello", "composer");
  assert.equal(action.type, "prompt");
  assert.equal(action.text, "hello");
  assert.equal(action.source, "composer");
  assert.match(action.id, /^action_/);
});
