import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ConversationHistory,
} from "@laohuang/session-context";
import {
  createSessionJournal,
  readSessionFile,
  type SessionJournal,
} from "@laohuang/session-store";
import {
  ProjectInstructionState,
  type InstructionFileRecord,
} from "@laohuang/project-instructions";

test("conversation history writes journal before updating in-memory entries", () => {
  const journal = openJournal();
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
  const entry = history.appendUser({
    message: { role: "user", content: "hello" },
    inputEventIds: ["input-1"],
    source: "direct",
  });

  assert.equal(history.entries().at(-1), entry);
  assert.deepEqual(readSessionFile(journal.path).items.map((item) => item.id), [entry.id]);
  journal.close();
});

test("conversation history keeps staged user input out of JSONL until committed", () => {
  const journal = openJournal();
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
  const staged = history.stageUser({
    message: { role: "user", content: "pending" },
    inputEventIds: ["event-2"],
    source: "pending",
  });

  assert.equal(history.entries().length, 0);
  assert.equal(readSessionFile(journal.path).items.length, 0);
  const committed = history.commitStagedUser(staged.token);
  assert.equal(committed.payload.message.content, "pending");
  assert.equal(history.entries().length, 1);

  const discard = history.stageUser({
    message: { role: "user", content: "discard" },
    inputEventIds: [],
    source: "pending",
  });
  history.discardStagedUser(discard.token);
  assert.equal(readSessionFile(journal.path).items.length, 1);
  journal.close();
});

test("conversation history appends assistant and ordered tool result entries", () => {
  const journal = openJournal();
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
  history.appendAssistant({
    message: {
      role: "assistant",
      provider: "pi-ai",
      model: "gpt-test",
      content: [
        { type: "tool-call", call: { id: "b", name: "second", arguments: {} } },
        { type: "tool-call", call: { id: "a", name: "first", arguments: {} } },
      ],
    },
    requestId: "request-1",
    finishReason: "tool-calls",
  });
  const results = history.appendToolResults({
    requestId: "request-1",
    messages: [
      { role: "tool-result", toolCallId: "b", toolName: "second", content: "B", isError: false },
      { role: "tool-result", toolCallId: "a", toolName: "first", content: "A", isError: false },
    ],
    recovered: false,
  });

  assert.deepEqual(results.map((entry) => entry.payload.message.toolCallId), ["b", "a"]);
  assert.deepEqual(history.entries().map((entry) => entry.entryType), [
    "assistant_message",
    "tool_result",
    "tool_result",
  ]);
  journal.close();
});

test("context reset is append-only and preserves prior entries", () => {
  const journal = openJournal();
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
  history.appendUser({
    message: { role: "user", content: "before clear" },
    inputEventIds: [],
    source: "direct",
  });
  const reset = history.reset("user_clear");

  assert.equal(reset.payload.resetThroughSeq, 1);
  assert.deepEqual(readSessionFile(journal.path).items.map((item) => item.kind), [
    "entry",
    "entry",
  ]);
  assert.deepEqual(history.entries().map((entry) => entry.entryType), [
    "user_message",
    "context_reset",
  ]);
  journal.close();
});

test("conversation history repairs interrupted open tool calls on replay", () => {
  const journal = openJournal();
  journal.appendEntry({
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
  });
  journal.close();

  const reopened = createSessionJournal({
    sessionsRoot: dirnameOfJournal(journal),
    header: journal.header,
    path: journal.path,
  });
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), reopened);

  const toolResult = history.entries().at(-1);
  assert.equal(toolResult?.entryType, "tool_result");
  assert.equal(toolResult?.payload.recovered, true);
  assert.equal(readSessionFile(journal.path).openToolCalls.length, 0);
  reopened.close();
});

test("project instruction state snapshots and restores records exactly", () => {
  const records: InstructionFileRecord[] = [
    { scope: "", displayPath: "AGENTS.md", digest: "abc" },
    { scope: "apps", displayPath: "apps/AGENTS.md", digest: "def" },
  ];
  const state = ProjectInstructionState.fromSnapshot(records);

  assert.deepEqual(state.snapshot(), records);
  assert.equal(state.hasScope("apps"), true);
  assert.equal(state.entry("AGENTS.md")?.digest, "abc");
});

function openJournal(): SessionJournal {
  return createSessionJournal({
    sessionsRoot: makeTempRoot(),
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
    origin: "new",
  });
}

function dirnameOfJournal(journal: SessionJournal): string {
  return join(journal.path, "..", "..");
}

function makeTempRoot(): string {
  const root = join(tmpdir(), `laohuang-conversation-history-${process.pid}-${Date.now()}-${Math.random()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
