import test from "node:test";
import assert from "node:assert/strict";

// NOTE: Node 22 type stripping cannot resolve ".js" specifiers to ".ts"
// sources, so test files import the ".ts" path directly (tsc only covers src/).
import { UIEventReducer } from "../packages/terminal/tui/src/tui/state.ts";

test("model deltas are provisional until committed", () => {
  const reducer = new UIEventReducer();

  reducer.apply({
    kind: "model.request_started",
    correlation_id: "request-1",
    payload: {},
  });
  const update = reducer.apply({
    kind: "model.text_delta",
    correlation_id: "request-1",
    payload: { text: "hello" },
  });

  assert.equal(update?.text, "hello");
  assert.equal(reducer.state.activeResponse?.text, "hello");
  assert.equal(reducer.state.activeResponse?.status, "provisional");

  reducer.apply({
    kind: "model.response_committed",
    correlation_id: "request-1",
    payload: {},
  });
  assert.equal(reducer.state.activeResponse?.status, "committed");
});

test("request budgets and model switches cannot overwrite display usage", () => {
  const reducer = new UIEventReducer();
  reducer.apply({ kind: "ui.context_usage", payload: { context_tokens: null, context_window: 128_000 } });

  reducer.apply({
    kind: "model.request_started",
    correlation_id: "request-1",
    payload: {
      context_tokens: 2048,
      context_window: 1_000_000,
    },
  });

  reducer.apply({ kind: "model.switched", payload: { context_tokens: 9999, context_window: 1_000_000 } });
  assert.equal(reducer.state.contextTokens, null);
  assert.equal(reducer.state.contextWindow, 128_000);
  reducer.apply({ kind: "ui.context_usage", payload: { context_tokens: 2048, context_window: 1_000_000 } });
  assert.equal(reducer.state.contextTokens, 2048);
});

test("parallel tool output is grouped by correlation id", () => {
  const reducer = new UIEventReducer();
  for (const toolId of ["call-1", "call-2"]) {
    reducer.apply({
      kind: "tool.started",
      correlation_id: toolId,
      payload: { name: "bash", arguments: {} },
    });
  }

  reducer.apply({
    kind: "tool.output_delta",
    correlation_id: "call-2",
    payload: { stream: "stderr", text: "warning" },
  });

  assert.equal(reducer.state.activeTools.get("call-1")?.stderr, "");
  assert.equal(reducer.state.activeTools.get("call-2")?.stderr, "warning");
});

test("stdout is retained for projection policy without changing stderr state", () => {
  const reducer = new UIEventReducer();
  reducer.apply({
    kind: "tool.started",
    correlation_id: "call-1",
    payload: { name: "bash", arguments: {} },
  });

  const update = reducer.apply({
    kind: "tool.output_delta",
    correlation_id: "call-1",
    payload: { stream: "stdout", text: "large output" },
  });

  assert.equal(update?.stream, "stdout");
  assert.equal(reducer.state.activeTools.get("call-1")?.stdout, "large output");
  assert.equal(reducer.state.activeTools.get("call-1")?.stderr, "");
});

test("response summaries accumulate token usage", () => {
  const reducer = new UIEventReducer();

  reducer.apply({
    kind: "model.response_summary",
    correlation_id: "request-1",
    payload: {
      usage: { prompt_tokens: 10, completion_tokens: 4 },
      total_tokens: 14,
    },
  });
  reducer.apply({
    kind: "model.response_summary",
    correlation_id: "request-2",
    payload: { usage: { input_tokens: 5, output_tokens: 2 } },
  });

  assert.equal(reducer.state.inputTokens, 15);
  assert.equal(reducer.state.outputTokens, 6);
  // Missing total_tokens leaves the previous total in place.
  assert.equal(reducer.state.totalTokens, 14);
});

test("task lifecycle events drive session state and counts", () => {
  const reducer = new UIEventReducer();

  const started = reducer.apply({
    kind: "task.started",
    correlation_id: "task-1",
    payload: { pending_count: 2, held_count: 1 },
  });
  assert.equal(started?.kind, "task.started");
  assert.equal(reducer.state.sessionState, "RUNNING_MODEL");
  assert.equal(reducer.state.pendingCount, 2);
  assert.equal(reducer.state.heldCount, 1);

  reducer.apply({
    kind: "tool.started",
    correlation_id: "call-1",
    payload: { name: "bash", arguments: { command: "ls" } },
  });
  assert.equal(reducer.state.sessionState, "RUNNING_TOOLS");
  assert.equal(reducer.state.activeTools.get("call-1")?.subject, "ls");

  reducer.apply({ kind: "task.failed", correlation_id: "task-1", payload: {} });
  assert.equal(reducer.state.sessionState, "FAILED");

  reducer.apply({
    kind: "task.state_changed",
    correlation_id: "",
    payload: { state: "idle" },
  });
  assert.equal(reducer.state.sessionState, "IDLE");
});
