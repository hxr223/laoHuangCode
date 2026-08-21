import test from "node:test";
import assert from "node:assert/strict";

import { EventBus, EventKind, EventSource } from "../src/events.ts";
import { EventLog, WebDashboard, consumePullBuffer } from "../src/web.ts";

test("reader can fetch only events after a known id", () => {
  const log = new EventLog();

  const first = log.record("user_message", { content: "hello" });
  const second = log.record("model_response", { round: 1, tool_call_count: 2 });

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.deepEqual(log.read(1), [second]);
});

test("browser can load dashboard and event api", async () => {
  const log = new EventLog();
  log.record("model_response", { round: 1, tool_call_count: 4 });
  const dashboard = new WebDashboard(log, { port: 0 });
  await dashboard.start();

  let page: string;
  let events: { events: Array<{ payload: Record<string, unknown> }> };
  try {
    const pageResponse = await fetch(dashboard.url);
    page = await pageResponse.text();
    const eventsResponse = await fetch(`${dashboard.url}api/events?after=0`);
    events = (await eventsResponse.json()) as typeof events;
  } finally {
    await dashboard.stop();
  }

  assert.ok(page.includes("laoHuangCode"));
  assert.equal(events.events[0]?.payload["tool_call_count"], 4);
});

test("pull buffer consumer records projected events until the bus closes", async () => {
  const bus = new EventBus();
  const log = new EventLog();
  const consumer = consumePullBuffer(bus, log);

  bus.publish(EventKind.InputUserMessage, {
    source: EventSource.User,
    session_id: "session-1",
    payload: { content: "hello" },
  });
  await bus.close();
  await consumer;

  const events = log.read();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "input.user_message");
  assert.equal(events[0]?.payload["content"], "hello");
  assert.equal(events[0]?.payload["session_id"], "session-1");
  assert.equal(events[0]?.payload["sequence"], 1);
});
