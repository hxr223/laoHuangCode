import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EventFactory,
  EventKind,
  EventSource,
  type AnyEventEnvelope,
} from "../packages/core/runtime-protocol/src/index.ts";
import {
  EventRouter,
  PendingQueue,
  QueueOverflowError,
} from "../src/routing.ts";
import { TaskRegistry, TaskState } from "../src/core/task-lifecycle.ts";

function userEvent(
  content: string,
  options: { taskId?: string; strategy?: string } = {},
): AnyEventEnvelope {
  const payload: { content: string; strategy?: string } = { content };
  if (options.strategy) {
    payload.strategy = options.strategy;
  }
  return new EventFactory().create(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    task_id: options.taskId ?? null,
    payload,
  });
}

function activeRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register("task-1");
  return registry;
}

test("layers short-circuit and cancel is final", async () => {
  const registry = activeRegistry();
  const classifierCalls: string[] = [];
  const router = new EventRouter(registry, {
    semanticClassifier: (event) => {
      classifierCalls.push(event.event_id);
      return "steer";
    },
  });

  const metadata = await router.route(userEvent("fix it", { taskId: "task-1" }));
  assert.equal(metadata.decision.layer, 1);
  assert.equal(metadata.decision.destination, "pending");
  assert.deepEqual(classifierCalls, []);

  const ambiguous = await router.route(userEvent("also consider tests"));
  assert.equal(ambiguous.decision.layer, 3);
  assert.equal(ambiguous.decision.strategy, "steer");
  assert.equal(classifierCalls.length, 1);

  const cancel = new EventFactory().create(EventKind.InputCancelRequested, {
    source: EventSource.User,
    session_id: "session-1",
  });
  const cancellation = await router.route(cancel);
  assert.equal(cancellation.decision.layer, 4);
  assert.equal(cancellation.decision.destination, "control");
  assert.equal(cancellation.decision.strategy, "cancel");
  assert.equal(classifierCalls.length, 1);
});

test("cancelling task holds ordinary input", async () => {
  const registry = activeRegistry();
  registry.transition("task-1", TaskState.Cancelling);
  const routed = await new EventRouter(registry).route(
    userEvent("one more thing"),
  );

  assert.equal(routed.decision.destination, "held");
  assert.equal(routed.decision.timing, "after_cancel");
});

test("pending queue drains all task messages in order", async () => {
  const registry = activeRegistry();
  const queue = new PendingQueue();
  const router = new EventRouter(registry);
  const first = await router.route(userEvent("first", { strategy: "steer" }));
  const followUp = await router.route(
    userEvent("later", { strategy: "follow_up" }),
  );
  const second = await router.route(userEvent("second", { strategy: "steer" }));
  for (const item of [first, followUp, second]) {
    queue.put(item);
  }

  const drained = queue.drainCompatible({ taskId: "task-1" });

  assert.deepEqual(
    drained.map((item) => item.event.payload["content"]),
    ["first", "later", "second"],
  );
  assert.deepEqual(queue.snapshot(), []);
});

test("queues are bounded", async () => {
  const registry = activeRegistry();
  const queue = new PendingQueue(1);
  const router = new EventRouter(registry);
  queue.put(await router.route(userEvent("first", { strategy: "steer" })));
  const second = await router.route(userEvent("second", { strategy: "steer" }));
  assert.throws(() => queue.put(second), QueueOverflowError);
});

test("pending queue enforces estimated token budget", async () => {
  const registry = activeRegistry();
  const queue = new PendingQueue(10, { maxEstimatedTokens: 2 });
  const router = new EventRouter(registry);

  const routed = await router.route(
    userEvent("this message is too large", { strategy: "steer" }),
  );
  assert.throws(() => queue.put(routed), /token budget/);
});
