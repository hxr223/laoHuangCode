import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EventBus,
  EventFactory,
  EventKind,
  EventProjector,
  EventSource,
  EventSpec,
  EventValidationError,
// NOTE: imported with the real ".ts" extension because tests run through
// Node 22 native type stripping, which does not remap ".js" specifiers.
} from "../src/events.ts";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function within<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("envelope and nested payload are immutable", () => {
  const event = new EventFactory().create(EventKind.ModelTextDelta, {
    source: EventSource.Model,
    session_id: "session-1",
    task_id: "task-1",
    correlation_id: "request-1",
    payload: { text: "hi", nested: { values: [1, 2] } },
  });

  assert.throws(() => {
    (event.payload as Record<string, unknown>)["text"] = "changed";
  }, TypeError);
  assert.throws(() => {
    (event.payload["nested"] as Record<string, unknown>)["values"] = [];
  }, TypeError);
  assert.deepEqual(
    (event.payload as Record<string, unknown>)["nested"],
    { values: [1, 2] },
  );
});

test("factory enforces registered spec", () => {
  const factory = new EventFactory(
    new Map([
      [
        EventKind.ModelTextDelta,
        new EventSpec({
          kind: EventKind.ModelTextDelta,
          sources: new Set([EventSource.Model]),
          required_payload: new Set(["text"]),
        }),
      ],
    ]),
  );

  assert.throws(
    () =>
      factory.create(EventKind.ModelTextDelta, {
        source: EventSource.Tool,
        session_id: "session-1",
        payload: {},
      }),
    EventValidationError,
  );
});

test("default specs reject user forged internal events", () => {
  assert.throws(
    () =>
      new EventFactory().create(EventKind.ToolStarted, {
        source: EventSource.User,
        session_id: "session-1",
      }),
    EventValidationError,
  );
});

test("projector recursively redacts secrets", () => {
  const event = new EventFactory().create(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: {
      content:
        "curl -H 'Authorization: Bearer top-secret' https://example.test",
      api_key: "key",
      headers: { Authorization: "Bearer token" },
    },
  });

  const projected = new EventProjector().project(event, "web");
  const payload = projected["payload"] as Record<string, unknown>;

  assert.equal(payload["api_key"], "[REDACTED]");
  assert.equal(
    (payload["headers"] as Record<string, unknown>)["Authorization"],
    "[REDACTED]",
  );
  assert.ok(!String(payload["content"]).includes("top-secret"));
});

test("bus assigns strict sequence and fans out", async () => {
  const bus = new EventBus();
  const observedA: number[] = [];
  const observedB: number[] = [];
  const unsubscribe = bus.subscribe((event) => {
    observedA.push(event.sequence);
  });
  bus.subscribe((event) => {
    observedB.push(event.sequence);
  });

  for (let index = 0; index < 20; index += 1) {
    bus.publish(EventKind.ModelTextDelta, {
      source: EventSource.Model,
      session_id: "session-1",
      task_id: "task-1",
      correlation_id: "request-1",
      payload: { text: "x" },
    });
  }
  await bus.flush();

  const expected = Array.from({ length: 20 }, (_v, i) => i + 1);
  assert.deepEqual(observedA, expected);
  assert.deepEqual(observedB, observedA);
  assert.deepEqual(
    bus.drain().map((event) => event.sequence),
    expected,
  );

  await unsubscribe();
  bus.publish(EventKind.SessionStopped, {
    source: EventSource.Session,
    session_id: "session-1",
  });
  await bus.flush();
  assert.equal(observedA.length, 20);
  assert.equal(observedB[observedB.length - 1], 21);
  await bus.close();
});

test("subscriber can publish without deadlocking", async () => {
  const bus = new EventBus();
  const observed: string[] = [];

  bus.subscribe((event) => {
    observed.push(event.kind);
    if (event.kind === EventKind.InputUserMessage) {
      bus.publish(EventKind.RoutingDecided, {
        source: EventSource.Router,
        session_id: "session-1",
        correlation_id: event.event_id,
        payload: {
          destination: "current_task",
          reason: "test callback",
        },
      });
    }
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "hello" },
  });
  await bus.flush();

  assert.deepEqual(observed, [
    EventKind.InputUserMessage,
    EventKind.RoutingDecided,
  ]);
  await bus.close();
});

test("slow subscriber does not block another subscriber", async () => {
  const bus = new EventBus();
  const slowEntered = deferred();
  const releaseSlow = deferred();
  const fastReceived = deferred();

  bus.subscribe(async () => {
    slowEntered.resolve();
    await releaseSlow.promise;
  });
  bus.subscribe(() => {
    fastReceived.resolve();
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "hello" },
  });

  await within(slowEntered.promise, 1000, "slow subscriber never entered");
  await within(fastReceived.promise, 200, "fast subscriber was blocked");
  releaseSlow.resolve();
  await bus.close();
});

test("full slow mailbox never blocks control publication", async () => {
  const bus = new EventBus({ subscriber_mailbox_size: 65 });
  const slowEntered = deferred();
  const releaseSlow = deferred();
  const fastControl = deferred();
  const slowObserved: Array<{
    kind: string;
    payload: Record<string, unknown>;
  }> = [];

  bus.subscribe(async (event) => {
    slowEntered.resolve();
    await releaseSlow.promise;
    slowObserved.push({
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
    });
  });
  bus.subscribe((event) => {
    if (event.kind === EventKind.UiMessage) {
      fastControl.resolve();
    }
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "start" },
  });
  await within(slowEntered.promise, 1000, "slow subscriber never entered");
  for (let index = 0; index < 200; index += 1) {
    bus.publish(EventKind.ModelTextDelta, {
      source: EventSource.Model,
      session_id: "session-1",
      task_id: "task-1",
      correlation_id: `request-${index % 2}`,
      payload: { text: "x" },
    });
  }
  bus.publish(EventKind.UiMessage, {
    source: EventSource.Session,
    session_id: "session-1",
    payload: { text: "control" },
  });

  await within(fastControl.promise, 200, "control event was blocked");
  releaseSlow.resolve();
  await bus.close();
  const slowControl = slowObserved.find(
    (event) => event.kind === EventKind.UiMessage,
  );
  assert.ok(slowControl);
  assert.ok(
    (slowControl.payload["_projection_dropped"] as number) > 0,
    "expected a projection gap marker on the control event",
  );
});

test("latest terminal event replaces old projection backlog", async () => {
  const bus = new EventBus({ subscriber_mailbox_size: 65 });
  const entered = deferred();
  const release = deferred();
  const observed: Array<{ kind: string; payload: Record<string, unknown> }> =
    [];

  bus.subscribe(async (event) => {
    entered.resolve();
    await release.promise;
    observed.push({
      kind: event.kind,
      payload: event.payload as Record<string, unknown>,
    });
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "start" },
  });
  await within(entered.promise, 1000, "subscriber never entered");
  for (let index = 0; index < 70; index += 1) {
    bus.publish(EventKind.UiMessage, {
      source: EventSource.Session,
      session_id: "session-1",
      payload: { text: `notice-${index}` },
    });
  }
  bus.publish(EventKind.SessionStopped, {
    source: EventSource.Session,
    session_id: "session-1",
  });
  release.resolve();
  await bus.close();

  const stopped = observed.find(
    (event) => event.kind === EventKind.SessionStopped,
  );
  assert.ok(stopped);
  assert.ok(
    (stopped.payload["_projection_dropped"] as number) > 0,
    "expected a projection gap marker on the lifecycle event",
  );
});

test("projection gap accumulates across repeated merges", async () => {
  const bus = new EventBus({ subscriber_mailbox_size: 67 });
  const entered = deferred();
  const release = deferred();
  const observed: Array<{
    kind: string;
    correlation_id: string | null;
    payload: Record<string, unknown>;
  }> = [];

  bus.subscribe(async (event) => {
    entered.resolve();
    await release.promise;
    observed.push({
      kind: event.kind,
      correlation_id: event.correlation_id,
      payload: event.payload as Record<string, unknown>,
    });
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "start" },
  });
  await within(entered.promise, 1000, "subscriber never entered");
  for (let index = 0; index < 2; index += 1) {
    bus.publish(EventKind.UiMessage, {
      source: EventSource.Session,
      session_id: "session-1",
      payload: { text: `notice-${index}` },
    });
  }
  for (const correlationId of [
    "request-a",
    "request-b",
    "request-a",
    "request-b",
    "request-a",
  ]) {
    bus.publish(EventKind.ModelTextDelta, {
      source: EventSource.Model,
      session_id: "session-1",
      task_id: "task-1",
      correlation_id: correlationId,
      payload: { text: "x" },
    });
  }
  release.resolve();
  await bus.close();

  const merged = observed.find(
    (event) =>
      event.kind === EventKind.ModelTextDelta &&
      event.correlation_id === "request-a",
  );
  assert.ok(merged);
  assert.equal(merged.payload["_projection_dropped"], 2);
});

test("subscriber can unsubscribe itself without deadlock", async () => {
  const bus = new EventBus();
  const completed = deferred();
  const holder: { unsubscribe?: () => Promise<void> } = {};

  holder.unsubscribe = bus.subscribe(() => {
    void holder.unsubscribe?.();
    completed.resolve();
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "hello" },
  });

  await within(completed.promise, 200, "self-unsubscribe deadlocked");
  await bus.close();
});

test("subscriber can await self-unsubscribe without deadlock", async () => {
  const bus = new EventBus();
  const completed = deferred();
  const holder: { unsubscribe?: () => Promise<void> } = {};

  holder.unsubscribe = bus.subscribe(async () => {
    // Mirrors Python's self-join guard: awaiting the mailbox close from
    // inside its own worker callback must not wait for that worker.
    await holder.unsubscribe?.();
    completed.resolve();
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "hello" },
  });

  await within(completed.promise, 200, "awaited self-unsubscribe deadlocked");
  await bus.close();
});

test("unsubscribe resolves only after queued events are delivered", async () => {
  const bus = new EventBus();
  const entered = deferred();
  const release = deferred();
  const observed: number[] = [];

  const unsubscribe = bus.subscribe(async (event) => {
    entered.resolve();
    await release.promise;
    observed.push(event.sequence);
  });
  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "hello" },
  });
  await within(entered.promise, 1000, "subscriber never entered");

  const done = unsubscribe();
  let resolved = false;
  void done.then(() => {
    resolved = true;
  });
  // The callback is still held, so the drain guarantee must keep
  // unsubscribe pending instead of returning while delivery can continue.
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  assert.equal(resolved, false, "unsubscribe returned before delivery");

  release.resolve();
  await done;
  assert.equal(observed.length, 1);

  bus.publish(EventKind.UiMessage, {
    source: EventSource.Session,
    session_id: "session-1",
    payload: { text: "after unsubscribe" },
  });
  await bus.flush();
  assert.equal(observed.length, 1);
  await bus.close();
});

test("default specs require model correlation metadata", () => {
  assert.throws(
    () =>
      new EventFactory().create(EventKind.ModelTextDelta, {
        source: EventSource.Model,
        session_id: "session-1",
        payload: { text: "hi" },
      }),
    (error: unknown) =>
      error instanceof EventValidationError && /task_id/.test(error.message),
  );
});

test("ui feedback shares event order and bus closes", async () => {
  const bus = new EventBus();
  const observed: string[] = [];
  bus.subscribe((event) => {
    observed.push(event.kind);
  });

  bus.publish(EventKind.ModelTextDelta, {
    source: EventSource.Model,
    session_id: "session-1",
    task_id: "task-1",
    correlation_id: "request-1",
    payload: { text: "earlier" },
  });
  bus.publish(EventKind.UiMessage, {
    source: EventSource.Session,
    session_id: "session-1",
    payload: { text: "later" },
  });
  await bus.close();

  assert.deepEqual(observed, [
    EventKind.ModelTextDelta,
    EventKind.UiMessage,
  ]);
  assert.throws(
    () =>
      bus.publish(EventKind.UiMessage, {
        source: EventSource.Session,
        session_id: "session-1",
        payload: { text: "too late" },
      }),
    /closed/,
  );
});
