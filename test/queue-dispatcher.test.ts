import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EventFactory,
  EventKind,
  EventSource,
  type AnyEventEnvelope,
} from "../src/events.ts";
import {
  DeadLetterQueue,
  EventRouter,
  PendingQueue,
  TaskRegistry,
  TaskState,
  type RoutedEvent,
} from "../src/routing.ts";
import { QueueDispatcher } from "../src/runtime/queue-dispatcher.ts";
import type { SessionAction } from "../src/runtime/session-action.ts";

function action(
  type: "prompt" | "steer" | "follow_up" | "cancel",
  id: string,
): SessionAction {
  switch (type) {
    case "prompt":
    case "steer":
    case "follow_up":
      return { id, source: "test", type, text: "message" };
    case "cancel":
      return { id, source: "test", type, reason: "test cancellation" };
  }
}

function userEvent(content: string, strategy?: string): AnyEventEnvelope {
  const payload: { content: string; strategy?: string } = { content };
  if (strategy !== undefined) {
    payload.strategy = strategy;
  }
  return new EventFactory().create(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload,
  });
}

async function routed(
  registry: TaskRegistry,
  content: string,
  strategy?: string,
): Promise<RoutedEvent> {
  return new EventRouter(registry).route(userEvent(content, strategy));
}

function withDestination(
  routedEvent: RoutedEvent,
  destination: RoutedEvent["decision"]["destination"],
): RoutedEvent {
  return {
    event: routedEvent.event,
    decision: { ...routedEvent.decision, destination },
  };
}

function runningRegistry(state: TaskState = TaskState.RunningModel): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register("task-1", { state });
  return registry;
}

test("idle prompt starts immediately despite pending router metadata", async () => {
  const dispatcher = new QueueDispatcher();
  const registry = new TaskRegistry();
  const result = dispatcher.dispatch(
    action("prompt", "action-1"),
    { state: "idle" },
    withDestination(await routed(registry, "start work"), "pending"),
  );

  assert.equal(result.status, "start_now");
  assert.equal(result.actionId, "action-1");
  assert.equal(dispatcher.pending.size, 0);
  assert.equal(dispatcher.held.size, 0);
});

test("running steer is queued as pending despite held router metadata", async () => {
  const dispatcher = new QueueDispatcher();
  const registry = runningRegistry();
  const result = dispatcher.dispatch(
    action("steer", "action-1"),
    { state: "running" },
    withDestination(
      await routed(registry, "change direction", "steer"),
      "held",
    ),
  );

  assert.equal(result.status, "pending");
  assert.equal(result.position, 1);
  assert.equal(dispatcher.pending.size, 1);
});

test("running follow-up is queued as pending despite new-task router metadata", async () => {
  const dispatcher = new QueueDispatcher();
  const registry = runningRegistry();
  const result = dispatcher.dispatch(
    action("follow_up", "action-1"),
    { state: "running" },
    withDestination(
      await routed(registry, "then do this", "follow_up"),
      "new_task",
    ),
  );

  assert.equal(result.status, "pending");
  assert.equal(result.position, 1);
  assert.equal(dispatcher.pending.size, 1);
});

test("cancelling prompt is held despite pending router metadata", async () => {
  const dispatcher = new QueueDispatcher();
  const registry = runningRegistry(TaskState.Cancelling);
  const result = dispatcher.dispatch(
    action("prompt", "action-1"),
    { state: "cancelling" },
    withDestination(await routed(registry, "wait for this"), "pending"),
  );

  assert.equal(result.status, "held");
  assert.equal(result.position, 1);
  assert.equal(dispatcher.held.size, 1);
});

test("non-idle new-task router metadata does not start immediately", async () => {
  const dispatcher = new QueueDispatcher();
  const registry = runningRegistry();
  const result = dispatcher.dispatch(
    action("prompt", "action-1"),
    { state: "running" },
    withDestination(await routed(registry, "do not replace the task"), "new_task"),
  );

  assert.equal(result.status, "ignored");
  assert.equal(dispatcher.pending.size, 0);
  assert.equal(dispatcher.held.size, 0);
});

test("cancel action requests immediate cancellation", async () => {
  const dispatcher = new QueueDispatcher();
  const registry = runningRegistry();
  const result = dispatcher.dispatch(
    action("cancel", "action-1"),
    { state: "running" },
    await routed(registry, "/cancel"),
  );

  assert.equal(result.status, "cancel_now");
  assert.equal(dispatcher.pending.size, 0);
  assert.equal(dispatcher.held.size, 0);
});

test("queue overflow sends the action to dead letters", async () => {
  const pending = new PendingQueue(1);
  const deadLetters = new DeadLetterQueue();
  const dispatcher = new QueueDispatcher({ pending, deadLetters });
  const registry = runningRegistry();
  const first = await routed(registry, "first", "steer");
  const second = await routed(registry, "second", "steer");

  dispatcher.dispatch(action("steer", "action-1"), { state: "running" }, first);
  const result = dispatcher.dispatch(
    action("steer", "action-2"),
    { state: "running" },
    second,
  );

  assert.equal(result.status, "dead_letter");
  assert.equal(result.reason, "pending queue is full");
  assert.equal(deadLetters.size, 1);
});
