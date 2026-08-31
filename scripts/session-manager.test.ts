import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  SessionManager,
  readSessionFile,
  type SessionEntry,
} from "@laohuang/session-store";

test("session manager lists latest sessions by project and marks corrupt files", () => {
  const root = makeTempRoot();
  const manager = makeManager(root);
  const first = manager.create({
    projectRoot: "/tmp/project-a",
    initialCwd: "/tmp/project-a",
    provider: "pi-ai",
    model: "old",
    reasoningEffort: "high",
  });
  first.journal.appendEntry(user("first"));
  first.journal.close();
  const second = manager.create({
    projectRoot: "/tmp/project-a",
    initialCwd: "/tmp/project-a",
    provider: "pi-ai",
    model: "new",
    reasoningEffort: "medium",
  });
  second.journal.appendEntry(user("second"));
  second.journal.close();
  const other = manager.create({
    projectRoot: "/tmp/project-b",
    initialCwd: "/tmp/project-b",
    provider: "pi-ai",
    model: "other",
    reasoningEffort: "high",
  });
  other.journal.close();
  writeFileSync(join(root, "broken.jsonl"), "{bad:\n", "utf8");

  const all = manager.list();
  assert.equal(all.some((item) => item.status === "corrupt"), true);

  const projectA = manager.list("/tmp/project-a");
  assert.deepEqual(projectA.map((item) => item.sessionId), [
    second.header.sessionId,
    first.header.sessionId,
  ]);
  assert.equal(projectA[0]!.lastUserText, "second");
  assert.equal(projectA.every((item) => item.projectRoot === "/tmp/project-a"), true);
  assert.equal(manager.continueLatest("/tmp/project-a")?.header.sessionId, second.header.sessionId);
});

test("fork before and at create independent child JSONL with copied semantic entries", () => {
  const root = makeTempRoot();
  const manager = makeManager(root);
  const parent = manager.create({
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  const first = parent.journal.appendEntry(user("first"));
  const assistant = parent.journal.appendEntry({
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
  parent.journal.appendEntry({
    entryType: "tool_result",
    payload: {
      message: {
        role: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        content: "ok",
        isError: false,
      },
      requestId: "request-1",
      recovered: false,
    },
  });
  const second = parent.journal.appendEntry(user("second"));
  parent.journal.close();

  const before = manager.fork({
    parentSessionId: parent.header.sessionId,
    entryId: second.id,
    mode: "before",
  });
  assert.equal(before.editorText, "second");
  const beforeReplay = readSessionFile(before.path);
  assert.equal(beforeReplay.header.parentSessionId, parent.header.sessionId);
  assert.equal(beforeReplay.header.forkedFrom?.entryId, second.id);
  assert.deepEqual(beforeReplay.items.map(entryType), [
    "user_message",
    "assistant_message",
    "tool_result",
  ]);
  assert.equal(beforeReplay.items[0]!.copiedFrom?.itemId, first.id);
  assert.equal(beforeReplay.items[1]!.copiedFrom?.itemId, assistant.id);
  assert.equal(beforeReplay.openToolCalls.length, 0);

  const at = manager.fork({
    parentSessionId: parent.header.sessionId,
    entryId: second.id,
    mode: "at",
  });
  assert.equal(at.editorText, "");
  assert.deepEqual(readSessionFile(at.path).items.map(entryType), [
    "user_message",
    "assistant_message",
    "tool_result",
    "user_message",
  ]);
});

test("clone copies semantic entries without runtime records", () => {
  const root = makeTempRoot();
  const manager = makeManager(root);
  const parent = manager.create({
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  const entry = parent.journal.appendEntry(user("hello"));
  parent.journal.appendRecord({ recordType: "turn_finished", payload: { ok: true } });
  parent.journal.close();

  const cloned = manager.clone({ parentSessionId: parent.header.sessionId });
  const replay = readSessionFile(cloned.path);
  assert.equal(replay.header.origin, "clone");
  assert.equal(replay.header.parentSessionId, parent.header.sessionId);
  assert.deepEqual(replay.items.map(entryType), ["user_message"]);
  assert.equal(replay.items[0]!.copiedFrom?.itemId, entry.id);
});

function user(content: string): Parameters<SessionManager["create"]>[0] & never {
  return {
    entryType: "user_message",
    payload: {
      message: { role: "user", content },
      inputEventIds: [],
      source: "direct",
    },
  } as never;
}

function entryType(item: { readonly kind: string }): string {
  assert.equal(item.kind, "entry");
  return (item as SessionEntry).entryType;
}

function makeManager(root: string): SessionManager {
  return new SessionManager({ sessionsRoot: root, appVersion: "0.7.0" });
}

function makeTempRoot(): string {
  const root = join(tmpdir(), `laohuang-session-manager-${process.pid}-${Date.now()}-${Math.random()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
