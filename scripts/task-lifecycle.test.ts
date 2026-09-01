import { test } from "node:test";
import assert from "node:assert/strict";

import { EventBus, EventKind } from "../packages/core/runtime-protocol/src/index.ts";
import {
  TaskLifecycle,
  TaskState,
} from "../packages/session/session-runtime/src/index.ts";

function makeLifecycle(): { lifecycle: TaskLifecycle; eventBus: EventBus } {
  const eventBus = new EventBus();
  return {
    lifecycle: new TaskLifecycle({
      eventBus,
      sessionId: "session-1",
      queueCounts: () => ({ pending: 2, held: 1 }),
    }),
    eventBus,
  };
}

test("transitions a task between model and tool execution", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.createTask("task-1");

  assert.equal(lifecycle.markToolsRunning("task-1"), true);
  assert.equal(
    lifecycle.taskRegistry.get("task-1")?.state,
    TaskState.RunningTools,
  );
  assert.equal(lifecycle.markModelRunning("task-1"), true);
  assert.equal(
    lifecycle.taskRegistry.get("task-1")?.state,
    TaskState.RunningModel,
  );
});

test("rejects resurrection from terminal states", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.createTask("task-1");
  assert.equal(lifecycle.completeTask("task-1", "done"), true);

  assert.equal(lifecycle.markToolsRunning("task-1"), false);
  assert.equal(lifecycle.requestCancel("task-1", "late cancel"), false);
  assert.equal(
    lifecycle.taskRegistry.get("task-1")?.state,
    TaskState.Completed,
  );
});

test("settles a cancelling task as cancelled", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.createTask("task-1");

  assert.equal(lifecycle.requestCancel("task-1", "user requested"), true);
  assert.equal(
    lifecycle.taskRegistry.get("task-1")?.state,
    TaskState.Cancelling,
  );
  assert.equal(lifecycle.finishCancelled("task-1"), true);
  assert.equal(
    lifecycle.taskRegistry.get("task-1")?.state,
    TaskState.Cancelled,
  );
});

test("repeated cancel is idempotent without republishing state", () => {
  const { lifecycle, eventBus } = makeLifecycle();
  lifecycle.createTask("task-1");

  assert.equal(lifecycle.requestCancel("task-1", "first"), true);
  assert.equal(lifecycle.requestCancel("task-1", "second"), true);

  assert.deepEqual(
    eventBus.drain().map((event) => event.kind),
    [EventKind.TaskStarted, EventKind.TaskStateChanged],
  );
});

test("allows only one active task", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.createTask("task-1");

  assert.throws(
    () => lifecycle.createTask("task-2"),
    /another task is already active/,
  );
  lifecycle.completeTask("task-1", "done");
  lifecycle.createTask("task-2");

  assert.equal(lifecycle.active()?.taskId, "task-2");
});

test("publishes lifecycle events with task state and queue counts", () => {
  const { lifecycle, eventBus } = makeLifecycle();
  lifecycle.createTask("task-1", { correlationId: "input-1" });
  lifecycle.markToolsRunning("task-1");
  lifecycle.requestCancel("task-1", "user requested");
  lifecycle.finishCancelled("task-1");

  const events = eventBus.drain();
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      EventKind.TaskStarted,
      EventKind.TaskStateChanged,
      EventKind.TaskStateChanged,
      EventKind.TaskCancelled,
    ],
  );
  assert.equal(events[0]?.correlation_id, "input-1");
  assert.deepEqual(events[1]?.payload, {
    state: TaskState.RunningTools,
    state_name: "RUNNING_TOOLS",
    pending_count: 2,
    held_count: 1,
  });
  assert.deepEqual(events[3]?.payload, {
    reason: "user requested",
    pending_count: 2,
    held_count: 1,
  });
});
