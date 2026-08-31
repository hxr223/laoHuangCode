import assert from "node:assert/strict";
import test from "node:test";

import {
  DefaultTokenEstimator,
  selectCompactionPlan,
} from "@laohuang/session-context";
import type { SessionEntry } from "@laohuang/session-store";

test("compaction cut points never split tool call and tool result semantic units", () => {
  const plan = selectCompactionPlan({
    entries: [
      user(1, "old"),
      assistantTool(2, "call-1"),
      toolResult(3, "call-1"),
      user(4, "tail"),
    ],
    retainTokens: 18,
    estimator: new DefaultTokenEstimator(),
  });

  assert.deepEqual(plan.summarizedEntries.map((entry) => entry.seq), [1]);
  assert.deepEqual(plan.retainedEntries.map((entry) => entry.seq), [2, 3, 4]);
  assert.equal(plan.retainedFromSeq, 2);
});

function base(seq: number): Omit<SessionEntry, "entryType" | "payload"> {
  return {
    schemaVersion: 1,
    sessionId: "session",
    seq,
    id: `e${seq}`,
    timestamp: "2026-08-31T00:00:00.000Z",
    kind: "entry",
  } as Omit<SessionEntry, "entryType" | "payload">;
}

function user(seq: number, content: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "user_message",
    payload: {
      message: { role: "user", content },
      inputEventIds: [],
      source: "direct",
    },
  } as SessionEntry;
}

function assistantTool(seq: number, callId: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "assistant_message",
    payload: {
      message: {
        role: "assistant",
        provider: "pi-ai",
        model: "gpt-test",
        content: [{ type: "tool-call", call: { id: callId, name: "read", arguments: { path: "a" } } }],
      },
      requestId: "request-1",
      finishReason: "tool-calls",
    },
  } as SessionEntry;
}

function toolResult(seq: number, callId: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "tool_result",
    payload: {
      message: { role: "tool-result", toolCallId: callId, toolName: "read", content: "ok", isError: false },
      requestId: "request-1",
      recovered: false,
    },
  } as SessionEntry;
}
