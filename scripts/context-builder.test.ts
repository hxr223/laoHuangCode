import assert from "node:assert/strict";
import test from "node:test";

import {
  ContextBuildError,
  ContextBuilder,
} from "@laohuang/session-context";
import type { SessionEntry } from "@laohuang/session-store";

test("context builder emits full un-compacted history in deterministic order", () => {
  const built = new ContextBuilder().build({
    entries: [
      system(1, "system"),
      project(2, "project"),
      user(3, "hello"),
      assistant(4, "answer"),
    ],
    currentProvider: "pi-ai",
    currentModel: "gpt-test",
  });

  assert.deepEqual(built.messages.map((message) => message.role), [
    "system",
    "user",
    "user",
    "assistant",
  ]);
  assert.deepEqual(built.sourceEntryIds, ["e1", "e2", "e3", "e4"]);
  assert.equal(built.activeCompactionId, null);
  assert.equal(built.resetEntryId, null);
});

test("context builder applies supersede, reset, summary, retained tail, and newer entries", () => {
  const built = new ContextBuilder().build({
    entries: [
      system(1, "old system"),
      { ...system(2, "new system"), payload: { message: { role: "system", content: "new system" }, cwd: "/tmp/project", supersedesEntryId: "e1" } },
      project(3, "old project"),
      { ...project(4, "new project"), payload: { message: { role: "user", content: "new project" }, files: [], supersedesEntryIds: ["e3"] } },
      user(5, "old user"),
      {
        ...base(6),
        kind: "entry",
        entryType: "context_reset",
        payload: { resetThroughSeq: 5, reason: "user_clear" },
      },
      user(7, "summarized user"),
      user(8, "retained user"),
      {
        ...base(9),
        kind: "entry",
        entryType: "compaction",
        payload: {
          summary: "summary text",
          summarizedFromSeq: 7,
          summarizedThroughSeq: 7,
          retainedFromSeq: 8,
          tokensBefore: 100,
          retainedTokens: 20,
          summaryInputTokens: 50,
          summaryOutputTokens: 10,
          provider: "pi-ai",
          model: "gpt-test",
          trigger: "manual",
        },
      },
      user(10, "new user"),
    ] as SessionEntry[],
    currentProvider: "pi-ai",
    currentModel: "gpt-test",
  });

  assert.deepEqual(
    built.messages.map((message) => message.content),
    [
      "new system",
      "new project",
      "<conversation_summary>\nsummary text\n</conversation_summary>",
      "retained user",
      "new user",
    ],
  );
  assert.deepEqual(built.sourceEntryIds, ["e2", "e4", "e9", "e8", "e10"]);
  assert.equal(built.activeCompactionId, "e9");
  assert.equal(built.resetEntryId, "e6");
});

test("context builder strips adapter replay for assistant messages from another route", () => {
  const built = new ContextBuilder().build({
    entries: [
      system(1, "system"),
      {
        ...base(2),
        kind: "entry",
        entryType: "assistant_message",
        payload: {
          message: {
            role: "assistant",
            provider: "other",
            model: "old",
            replay: { adapter: "private", version: 1, state: { id: "opaque" } },
            content: [{ type: "text", text: "portable" }],
          },
          requestId: "request-1",
          finishReason: "stop",
        },
      },
    ] as SessionEntry[],
    currentProvider: "pi-ai",
    currentModel: "gpt-test",
  });

  assert.equal("replay" in built.messages[1]!, false);
});

test("context builder rejects missing and orphan tool results", () => {
  assert.throws(
    () => new ContextBuilder().build({
      entries: [
        system(1, "system"),
        {
          ...base(2),
          kind: "entry",
          entryType: "assistant_message",
          payload: {
            message: {
              role: "assistant",
              provider: "pi-ai",
              model: "gpt-test",
              content: [{ type: "tool-call", call: { id: "call-1", name: "read", arguments: {} } }],
            },
            requestId: "request-1",
            finishReason: "tool-calls",
          },
        },
      ] as SessionEntry[],
      currentProvider: "pi-ai",
      currentModel: "gpt-test",
    }),
    ContextBuildError,
  );

  assert.throws(
    () => new ContextBuilder().build({
      entries: [
        system(1, "system"),
        {
          ...base(2),
          kind: "entry",
          entryType: "tool_result",
          payload: {
            message: {
              role: "tool-result",
              toolCallId: "missing",
              toolName: "read",
              content: "no call",
              isError: true,
            },
            requestId: "request-1",
            recovered: false,
          },
        },
      ] as SessionEntry[],
      currentProvider: "pi-ai",
      currentModel: "gpt-test",
    }),
    ContextBuildError,
  );
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

function system(seq: number, content: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "system_context",
    payload: { message: { role: "system", content }, cwd: "/tmp/project" },
  } as SessionEntry;
}

function project(seq: number, content: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "project_instructions",
    payload: { message: { role: "user", content }, files: [], supersedesEntryIds: [] },
  } as SessionEntry;
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

function assistant(seq: number, content: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "assistant_message",
    payload: {
      message: {
        role: "assistant",
        provider: "pi-ai",
        model: "gpt-test",
        content: [{ type: "text", text: content }],
      },
      requestId: "request-1",
      finishReason: "stop",
    },
  } as SessionEntry;
}
