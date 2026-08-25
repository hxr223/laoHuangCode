import test from "node:test";
import assert from "node:assert/strict";

import { DisplayPolicy } from "../src/tui/display-policy.ts";
import { makeToggleToolOutputDisplayAction } from "../src/tui/display-actions.ts";
import { isSessionAction } from "../src/core/session-action-protocol.ts";

function event(
  kind: string,
  payload: Record<string, unknown> = {},
): { kind: string; correlation_id: string; payload: Record<string, unknown> } {
  return { kind, correlation_id: "call-1", payload };
}

test("terminal policy folds stdout by default", () => {
  const policy = new DisplayPolicy({ audience: "terminal" });

  assert.deepEqual(
    policy.project(event("tool.output_delta", { stream: "stdout", text: "large output" })),
    [],
  );
});

test("terminal policy shows a stderr summary", () => {
  const policy = new DisplayPolicy({ audience: "terminal" });

  const projected = policy.project(
    event("tool.output_delta", { stream: "stderr", text: "permission denied" }),
  );

  assert.deepEqual(projected, [
    {
      kind: "tool.output_delta",
      correlationId: "call-1",
      stream: "stderr",
      text: "permission denied",
      payload: { stream: "stderr", text: "permission denied" },
    },
  ]);
});

test("terminal policy displays reasoning deltas", () => {
  const policy = new DisplayPolicy({ audience: "terminal" });

  assert.equal(
    policy.project(event("model.reasoning_delta", { text: "checking files" }))[0]?.text,
    "checking files",
  );
});

test("projection gaps become a display marker before the event", () => {
  const policy = new DisplayPolicy({ audience: "terminal" });

  const projected = policy.project(
    event("model.text_delta", { text: "answer", _projection_dropped: 3 }),
  );

  assert.equal(projected[0]?.kind, "display.gap");
  assert.match(projected[0]?.text ?? "", /3/);
  assert.equal(projected[1]?.text, "answer");
});

test("lifecycle events are never dropped", () => {
  const policy = new DisplayPolicy({ audience: "terminal" });

  for (const kind of ["task.started", "task.completed", "task.failed", "task.cancelled"]) {
    assert.equal(policy.project(event(kind)).length, 1, kind);
  }
});

test("tool output toggles remain local display actions", () => {
  const action = makeToggleToolOutputDisplayAction(true);

  assert.deepEqual(action, { type: "toggle_tool_output", expanded: true });
  assert.equal(isSessionAction(action), false);
});

test("session action guard rejects malformed variants", () => {
  assert.equal(
    isSessionAction({ id: "action-1", type: "prompt", source: "editor" }),
    false,
  );
});
