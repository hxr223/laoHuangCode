import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { EventBus, EventKind, EventSource } from "../packages/core/runtime-protocol/src/index.ts";
import { createSessionJournal, readSessionFile } from "../packages/session/session-store/src/index.ts";
import { SessionRecorder } from "../packages/session/session-runtime/src/index.ts";

test("session recorder persists stable runtime records from event bus", async () => {
  const root = makeTempRoot();
  const journal = createSessionJournal({
    sessionsRoot: root,
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
  });
  const eventBus = new EventBus();
  const recorder = new SessionRecorder({ eventBus, journal });

  eventBus.publish(EventKind.TaskStarted, {
    source: EventSource.Session,
    session_id: journal.header.sessionId,
    task_id: "task-1",
    payload: { content: "hello" },
  });
  eventBus.publish(EventKind.ModelResponseCommitted, {
    source: EventSource.Model,
    session_id: journal.header.sessionId,
    task_id: "task-1",
    correlation_id: "request-1",
    payload: {
      usage: { inputTokens: 12, outputTokens: 3 },
      Authorization: "Bearer secret-token",
    },
  });
  await eventBus.flush();
  await recorder.close();
  journal.close();

  const records = readSessionFile(journal.path).items.filter((item) => item.kind === "record");
  assert.deepEqual(records.map((item) => item.recordType), [
    "turn_started",
    "model_response",
    "usage",
  ]);
  assert.equal(records[2]?.payload["usage"] !== undefined, true);
  assert.equal(JSON.stringify(records).includes("secret-token"), false);
  assert.equal(JSON.stringify(records).includes("[REDACTED]"), true);
});

function makeTempRoot(): string {
  const root = join(tmpdir(), `laohuang-session-recorder-${process.pid}-${Date.now()}-${Math.random()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
