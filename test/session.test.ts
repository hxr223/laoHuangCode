import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { EventKind, EventSource } from "../src/events.ts";
import type { SessionLike } from "../src/commands.ts";
import { TaskState, type SemanticClassifierVerdict } from "../src/routing.ts";
import {
  AgentSession,
  type TaskContext,
  type TaskRunnerResult,
} from "../src/session.ts";

/** Promise-based stand-in for the threading.Event gates the Python tests use. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function awaitGate(promise: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${label}`)),
          2000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

type Runner = (
  content: string,
  context: TaskContext,
) => TaskRunnerResult;

test("session satisfies the SessionLike command interface", () => {
  const session = new AgentSession(() => null, { sessionId: "session-1" });
  // Compile-time conformance with src/commands.ts SessionLike.
  const like: SessionLike = session;
  assert.equal(like.sessionId, "session-1");
  assert.equal(like.cancelActiveTask(), false);
  assert.equal(like.clearQueues(), 0);
  assert.equal(like.resumeHeld(), 0);
  assert.deepEqual(like.queueStatus(), {
    pending: 0,
    held: 0,
    deadLetters: 0,
    pendingTokens: 0,
    heldTokens: 0,
  });
});

test("pending messages are drained once as one model input", async () => {
  const entered = gate();
  const release = gate();
  const calls: string[] = [];

  const runner: Runner = async (content, _context) => {
    calls.push(content);
    if (calls.length === 1) {
      entered.open();
      await release.promise;
    }
    return `answer-${calls.length}`;
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  const submission = await session.submitInput("first");
  await awaitGate(entered.promise, "runner entry");
  await session.submitInput("second", { strategy: "steer" });
  await session.submitInput("third", { strategy: "follow_up" });
  release.open();

  assert.equal(await session.waitForIdle(1000), true);
  assert.equal(calls[0], "first");
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.includes("second"));
  assert.ok(calls[1]!.includes("third"));
  assert.ok(calls[1]!.includes("Please handle all"));
  assert.equal(
    session.taskRegistry.get(submission.taskId!)!.state,
    TaskState.Completed,
  );
});

test("stale worker cannot mark replacement task idle", async () => {
  const entered = gate();
  const release = gate();

  const runner: Runner = async (_content, _context) => {
    entered.open();
    await release.promise;
    return "done";
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  await session.submitInput("replacement task");
  await awaitGate(entered.promise, "runner entry");

  session._settleWorker({});

  assert.notEqual(session.activeTask, null);
  assert.equal(session.state, "running");
  assert.equal(await session.waitForIdle(0), false);
  release.open();
  assert.equal(await session.waitForIdle(1000), true);
  assert.equal(await session.close(), true);
});

test("cancel stops task and moves pending to held", async () => {
  const entered = gate();

  const runner: Runner = async (_content, context) => {
    entered.open();
    await context.cancelToken.wait(1000);
    context.cancelToken.throwIfCancelled();
    throw new Error("cancellation should have interrupted the runner");
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  const submission = await session.submitInput("long task");
  await awaitGate(entered.promise, "runner entry");
  await session.submitInput("do this afterward", { strategy: "follow_up" });

  assert.equal(session.requestCancel("test cancellation"), true);
  assert.equal(await session.waitForIdle(1000), true);
  const record = session.taskRegistry.get(submission.taskId!)!;
  assert.equal(record.state, TaskState.Cancelled);
  assert.equal(record.cancelToken.reason, "test cancellation");
  assert.equal(session.pendingCount, 0);
  assert.equal(session.heldCount, 1);

  const events = session.eventBus.drain();
  assert.ok(events.some((event) => event.kind === EventKind.TaskCancelled));
});

test("cancel wins over task completion at the return boundary", async () => {
  const entered = gate();
  const release = gate();

  const runner: Runner = async (_content, _context) => {
    entered.open();
    await release.promise;
    return "must not commit";
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  const submission = await session.submitInput("work");
  await awaitGate(entered.promise, "runner entry");
  assert.equal(session.requestCancel("boundary cancel"), true);
  release.open();

  assert.equal(await session.waitForIdle(1000), true);
  const record = session.taskRegistry.get(submission.taskId!)!;
  assert.equal(record.state, TaskState.Cancelled);
  const kinds = session.eventBus.drain().map((event) => event.kind);
  assert.ok(kinds.includes(EventKind.TaskCancelled));
  assert.ok(!kinds.includes(EventKind.TaskCompleted));
});

test("cancel after pending claim moves batch to held", async () => {
  const firstEntered = gate();
  const releaseFirst = gate();
  const claimedEntered = gate();

  const runner: Runner = async (content, context) => {
    if (content === "first") {
      firstEntered.open();
      await releaseFirst.promise;
      return "first done";
    }
    claimedEntered.open();
    await context.cancelToken.wait(1000);
    context.cancelToken.throwIfCancelled();
    return "must not finish";
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  const submission = await session.submitInput("first");
  await awaitGate(firstEntered.promise, "first runner entry");
  await session.submitInput("claimed pending", { strategy: "steer" });
  releaseFirst.open();
  await awaitGate(claimedEntered.promise, "claimed batch entry");

  assert.equal(session.requestCancel("cancel claimed batch"), true);
  assert.equal(await session.waitForIdle(1000), true);
  assert.equal(
    session.taskRegistry.get(submission.taskId!)!.state,
    TaskState.Cancelled,
  );
  assert.equal(session.pendingCount, 0);
  assert.equal(session.heldCount, 1);
  const held = session.held.drain();
  assert.ok(String(held[0]!.event.payload["content"]).includes("claimed pending"));
});

test("cancel after pending history commit rolls back and holds", async () => {
  const firstEntered = gate();
  const releaseFirst = gate();
  const historyCommitted = gate();
  const history: Array<{ role: string; content: string }> = [];

  const runner: Runner = async (content, context) => {
    if (content === "first") {
      firstEntered.open();
      await releaseFirst.promise;
      const batch = context.safePoint();
      const message = { role: "user", content: batch.content };
      assert.equal(
        context.commitPending(
          batch,
          () => {
            history.push(message);
          },
          () => {
            history.pop();
          },
        ),
        true,
      );
      historyCommitted.open();
      await context.cancelToken.wait(1000);
      context.cancelToken.throwIfCancelled();
    }
    return "done";
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  const submission = await session.submitInput("first");
  await awaitGate(firstEntered.promise, "first runner entry");
  await session.submitInput("not sent yet", { strategy: "steer" });
  releaseFirst.open();
  await awaitGate(historyCommitted.promise, "history commit");
  assert.equal(history.length, 1);

  assert.equal(session.requestCancel("pre-request cancel"), true);
  assert.equal(await session.waitForIdle(1000), true);
  assert.deepEqual(history, []);
  assert.equal(session.heldCount, 1);
  assert.equal(
    session.taskRegistry.get(submission.taskId!)!.state,
    TaskState.Cancelled,
  );
});

test("repeated safe point does not drop a second batch", async () => {
  const entered = gate();
  const release = gate();
  const firstClaimed = gate();
  const releaseSecond = gate();

  const runner: Runner = async (_content, context) => {
    entered.open();
    await release.promise;
    assert.ok(context.safePoint().events.length > 0);
    firstClaimed.open();
    await releaseSecond.promise;
    context.safePoint();
    return "unreachable";
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  const submission = await session.submitInput("first");
  await awaitGate(entered.promise, "runner entry");
  await session.submitInput("pending one", { strategy: "steer" });
  release.open();
  await awaitGate(firstClaimed.promise, "first claim");
  await session.submitInput("pending two", { strategy: "steer" });
  releaseSecond.open();

  assert.equal(await session.waitForIdle(1000), true);
  assert.equal(
    session.taskRegistry.get(submission.taskId!)!.state,
    TaskState.Failed,
  );
  assert.equal(session.pendingCount, 0);
  assert.equal(session.heldCount, 2);
});

test("slash command is local control and does not start task", async () => {
  const session = new AgentSession(
    () => {
      throw new Error("runner should not be called");
    },
    { sessionId: "session-1" },
  );

  const submission = await session.submitInput("/model");

  assert.equal(submission.control, true);
  assert.equal(submission.taskId, null);
  assert.equal(session.activeTask, null);
});

test("internal model callback passes through router", async () => {
  const runner: Runner = async (_content, context) => {
    await context.publish(EventKind.ModelTextDelta, {
      source: EventSource.Model,
      correlation_id: "request-1",
      payload: { request_id: "request-1", text: "hello" },
    });
    return "done";
  };

  const session = new AgentSession(runner, { sessionId: "session-1" });
  await session.submitInput("start");
  assert.equal(await session.waitForIdle(1000), true);

  const events = session.eventBus.drain();
  const modelEvent = events.find(
    (event) => event.kind === EventKind.ModelTextDelta,
  )!;
  const routeEvent = events.find(
    (event) =>
      event.kind === EventKind.RoutingDecided &&
      event.correlation_id === modelEvent.event_id,
  )!;
  assert.ok(routeEvent.sequence < modelEvent.sequence);
});

test("input classified during cancel is held not auto-started", async () => {
  const taskStarted = gate();
  const classifierEntered = gate();
  const releaseClassifier = gate();
  const calls: string[] = [];

  const runner: Runner = async (content, context) => {
    calls.push(content);
    taskStarted.open();
    await context.cancelToken.wait(1000);
    context.cancelToken.throwIfCancelled();
    return "done";
  };

  const classifier = (): Promise<SemanticClassifierVerdict> => {
    classifierEntered.open();
    return releaseClassifier.promise.then(() => "follow_up");
  };

  const session = new AgentSession(runner, {
    sessionId: "session-1",
    semanticClassifier: classifier,
  });
  await session.submitInput("first");
  await awaitGate(taskStarted.promise, "task start");
  let submission: Awaited<ReturnType<AgentSession["submitInput"]>> | undefined;
  const submitter = session
    .submitInput("second")
    .then((result) => {
      submission = result;
    });
  await awaitGate(classifierEntered.promise, "classifier entry");

  assert.equal(session.requestCancel(), true);
  releaseClassifier.open();
  await submitter;
  assert.equal(await session.waitForIdle(1000), true);

  assert.deepEqual(calls, ["first"]);
  assert.equal(session.heldCount, 1);
  assert.equal(submission!.routed.decision.destination, "held");
});

test("close returns only after subscribers saw SessionStopped", async () => {
  const session = new AgentSession(() => null, { sessionId: "session-1" });
  const observed: string[] = [];
  session.eventBus.subscribe(async (event) => {
    if (event.kind === EventKind.SessionStopped) {
      // Slow projection: Python's close() blocks on the mailbox drain, so a
      // returned close() implies this callback already ran to completion.
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      observed.push(event.kind);
    }
  });

  assert.equal(await session.close(), true);
  assert.deepEqual(observed, [EventKind.SessionStopped]);
});

test("close({wait: false}) still drains the event bus", async () => {
  const session = new AgentSession(() => null, { sessionId: "session-1" });
  const observed: string[] = [];
  session.eventBus.subscribe(async (event) => {
    if (event.kind === EventKind.SessionStopped) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      observed.push(event.kind);
    }
  });

  assert.equal(await session.close({ wait: false }), true);
  assert.equal(session.state, "stopped");
  assert.deepEqual(observed, [EventKind.SessionStopped]);
});

test("a pending waitForIdle does not keep the process alive", () => {
  const script = `
    import { AgentSession } from ${JSON.stringify(new URL("../src/session.ts", import.meta.url).href)};
    const session = new AgentSession(() => new Promise(() => {}), {
      sessionId: "session-1",
    });
    await session.submitInput("hang");
    // 60s timeout: if the timer were not unref'd the process would linger.
    void session.waitForIdle(60_000);
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { timeout: 5000 },
  );
  assert.equal(
    result.status,
    0,
    `child did not exit promptly: ${String(result.error)} ${result.stderr?.toString() ?? ""}`,
  );
});
