import { test } from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../src/events.ts";
import {
  AgentTurnLoop,
  type AgentTurnContext,
} from "../src/runtime/agent-turn-loop.ts";
import type {
  QueueBridge,
  QueueInputBatch,
} from "../src/runtime/queue-bridge.ts";
import {
  TaskLifecycle,
  TaskState,
} from "../src/runtime/task-lifecycle.ts";

class TestContext implements AgentTurnContext {
  readonly cancelToken;
  claimed: QueueInputBatch | null = null;

  constructor(lifecycle: TaskLifecycle, taskId: string) {
    const record = lifecycle.taskRegistry.get(taskId);
    if (record === null) {
      throw new Error(`unknown task: ${taskId}`);
    }
    this.cancelToken = record.cancelToken;
  }

  setClaimedInput(batch: QueueInputBatch | null): void {
    this.claimed = batch;
  }
}

class TestQueueBridge implements QueueBridge {
  pending: QueueInputBatch[] = [];
  held: QueueInputBatch[] = [];
  acknowledged: string[][] = [];

  drainPending(): QueueInputBatch | null {
    return this.pending.shift() ?? null;
  }

  acknowledgeClaimedInput(_taskId: string, eventIds: readonly string[]): boolean {
    this.acknowledged.push([...eventIds]);
    return true;
  }

  preserveTaskInputs(_taskId: string, _reason: string): number {
    this.held.push(...this.pending.splice(0));
    return this.held.length;
  }
}

function makeLifecycle(): TaskLifecycle {
  return new TaskLifecycle({
    eventBus: new EventBus(),
    sessionId: "session-1",
  });
}

function createLoop(
  lifecycle: TaskLifecycle,
  bridge: QueueBridge,
  runner: (content: string, context: AgentTurnContext) => string | null | Promise<string | null>,
): AgentTurnLoop {
  return new AgentTurnLoop({ lifecycle, bridge, runner });
}

test("completes when no pending input remains", async () => {
  const lifecycle = makeLifecycle();
  lifecycle.createTask("task-1");
  const bridge = new TestQueueBridge();
  const loop = createLoop(lifecycle, bridge, async () => "done");

  const outcome = await loop.run("task-1", "first", new TestContext(lifecycle, "task-1"));

  assert.deepEqual(outcome, { status: "completed", result: "done" });
  assert.equal(lifecycle.taskRegistry.get("task-1")?.state, TaskState.Completed);
});

test("continues with a drained pending batch", async () => {
  const lifecycle = makeLifecycle();
  lifecycle.createTask("task-1");
  const bridge = new TestQueueBridge();
  bridge.pending.push({ content: "follow-up", eventIds: ["event-2"] });
  const calls: string[] = [];
  const loop = createLoop(lifecycle, bridge, async (content) => {
    calls.push(content);
    return "done";
  });

  const outcome = await loop.run("task-1", "first", new TestContext(lifecycle, "task-1"));

  assert.deepEqual(calls, ["first", "follow-up"]);
  assert.deepEqual(bridge.acknowledged, [["event-2"]]);
  assert.deepEqual(outcome, { status: "completed", result: "done" });
});

test("cancellation at the return boundary settles as cancelled", async () => {
  const lifecycle = makeLifecycle();
  lifecycle.createTask("task-1");
  const bridge = new TestQueueBridge();
  const loop = createLoop(lifecycle, bridge, async () => {
    lifecycle.requestCancel("task-1", "boundary cancellation");
    return "must not complete";
  });

  const outcome = await loop.run("task-1", "first", new TestContext(lifecycle, "task-1"));

  assert.deepEqual(outcome, { status: "cancelled" });
  assert.equal(lifecycle.taskRegistry.get("task-1")?.state, TaskState.Cancelled);
});

test("runner failure fails the task and preserves pending input", async () => {
  const lifecycle = makeLifecycle();
  lifecycle.createTask("task-1");
  const bridge = new TestQueueBridge();
  bridge.pending.push({ content: "follow-up", eventIds: ["event-2"] });
  const loop = createLoop(lifecycle, bridge, async () => {
    throw new Error("runner failed");
  });

  const outcome = await loop.run("task-1", "first", new TestContext(lifecycle, "task-1"));

  assert.deepEqual(outcome, { status: "failed", error: "runner failed" });
  assert.equal(lifecycle.taskRegistry.get("task-1")?.state, TaskState.Failed);
  assert.deepEqual(bridge.held, [{ content: "follow-up", eventIds: ["event-2"] }]);
});
