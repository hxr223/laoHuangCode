import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ContextBuilder, ContextGovernor, ContextUsage, DefaultTokenEstimator, selectCompactionPlan } from "@laohuang/session-context";
import { parseSessionItem, projectTranscript, readSessionFile, scanAttachmentReferences, SessionManager, type SessionEntry, type SessionItem } from "@laohuang/session-store";

function base(seq: number) {
  return { schemaVersion: 1 as const, sessionId: "legacy", seq, id: `e${seq}`, timestamp: "2026-08-31T00:00:00Z", kind: "entry" as const };
}
function user(seq: number, content: string): SessionEntry {
  return { ...base(seq), entryType: "user_message", payload: { message: { role: "user", content }, inputEventIds: [], source: "direct" } };
}
function reset(seq: number, resetThroughSeq = seq - 1): SessionEntry {
  return { ...base(seq), entryType: "context_reset", payload: { resetThroughSeq, reason: "user_clear" } };
}
function compaction(seq: number): SessionEntry {
  return { ...base(seq), entryType: "compaction", payload: { summary: "old summary", summarizedFromSeq: 1, summarizedThroughSeq: 2, retainedFromSeq: 3,
    tokensBefore: 100, retainedTokens: 10, summaryInputTokens: 20, summaryOutputTokens: 10, provider: "fake", model: "test", trigger: "manual" } };
}
function fixture(t: TestContext, items: readonly SessionItem[]) {
  const root = mkdtempSync(join(tmpdir(), "laohuang-legacy-reset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "legacy.jsonl");
  const header = { schemaVersion: 1, type: "session_header", sessionId: "legacy", createdAt: "2026-08-31T00:00:00Z",
    initialCwd: root, projectRoot: root, projectKey: "legacy", appVersion: "old", provider: "fake", model: "test", reasoningEffort: "off", origin: "new" };
  writeFileSync(path, [header, ...items].map(item => JSON.stringify(item)).join("\n") + "\n");
  return { root, path };
}
function build(entries: readonly SessionEntry[]) {
  return new ContextBuilder().build({ entries, currentProvider: "fake", currentModel: "test" });
}

test("legacy reset: validates exact legacy payload and still rejects unknown types", () => {
  assert.deepEqual(parseSessionItem(reset(2)), reset(2));
  assert.doesNotThrow(() => parseSessionItem(reset(1, 0)));
  for (const boundary of [-1, 1.5, "1", 2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseSessionItem({ ...reset(2), payload: { resetThroughSeq: boundary, reason: "user_clear" } }), /legacy context reset/);
  }
  for (const payload of [{ resetThroughSeq: 1 }, { resetThroughSeq: 1, reason: "unknown" }, { resetThroughSeq: 1, reason: "user_clear", message: {} }]) {
    assert.throws(() => parseSessionItem({ ...reset(2), payload }), /legacy context reset/);
  }
  assert.throws(() => parseSessionItem({ ...reset(2), entryType: "unknown" }), /invalid session entry type/);
});

test("legacy reset: preserves system instructions but excludes old messages, summaries and tool calls", () => {
  const entries: SessionEntry[] = [
    { ...base(1), entryType: "system_context", payload: { message: { role: "system", content: "system" }, cwd: "/project" } },
    { ...base(2), entryType: "project_instructions", payload: { message: { role: "user", content: "instructions" }, files: [], supersedesEntryIds: [] } },
    user(3, "cleared"), compaction(4), reset(5), user(6, "current"),
  ];
  assert.deepEqual(build(entries).messages.map(message => message.content), ["system", "instructions", "current"]);
  assert.equal(build(entries).activeCompactionId, null);
  assert.deepEqual(build([...entries, reset(7), user(8, "newest")]).sourceEntryIds, ["e1", "e2", "e8"]);
  assert.ok(projectTranscript(entries).some(item => item.kind === "notice" && item.text === "Conversation context was cleared."));
  assert.equal(new ContextUsage([user(1, "old"), reset(2)]).tokens, null);
});

test("legacy reset: compaction never summarizes cleared history or supersedes its old summary", async () => {
  const entries = [user(1, "cleared secret"), compaction(2), reset(3), user(4, "new earlier"), user(5, "new latest")];
  const plan = selectCompactionPlan({ entries, retainTokens: 1, estimator: new DefaultTokenEstimator() });
  assert.deepEqual(plan.summarizedEntries.map(entry => entry.id), ["e4"]);
  let serialized = "";
  const governor = new ContextGovernor({
    summarize: async input => { serialized = input.serialized; return { summary: "new summary", inputTokens: 1, outputTokens: 1 }; },
    appendCompaction: payload => ({ ...base(6), entryType: "compaction", payload }),
  });
  const result = await governor.compact({ entries, currentProvider: "fake", currentModel: "test", tools: [], trigger: "manual",
    budget: { contextWindow: 1000, maxOutputTokens: 100 },
    policy: { auto: true, thresholdRatio: 0.8, retainRatio: 0.1, retainTokens: 1, maxSummaryTokens: 100, safetyRatio: 0.1 } });
  assert.doesNotMatch(serialized, /cleared secret|old summary/);
  assert.equal(result.entry.payload.supersedesCompactionId, undefined);
  assert.deepEqual(build([...entries, result.entry]).sourceEntryIds, ["e6", "e5"]);
});

test("legacy reset: full journal scans retain pre-reset attachments and do not rewrite history", t => {
  const ref = { id: `sha256:${"a".repeat(64)}` as const, name: "old.png", bytes: 10, mimeType: "image/png" as const, width: 1, height: 1, animated: false };
  const old: SessionEntry = { ...base(1), entryType: "user_message", payload: { message: { role: "user", content: "old image", attachmentKey: "old", attachments: [{ type: "image", ref }] }, inputEventIds: [], source: "direct" } };
  const { root, path } = fixture(t, [old, reset(2), user(3, "new")]);
  const before = readFileSync(path);
  assert.deepEqual([...scanAttachmentReferences(root)], [ref.id]);
  assert.deepEqual(build(readSessionFile(path).items.filter(item => item.kind === "entry")).sourceEntryIds, ["e3"]);
  assert.deepEqual(readFileSync(path), before);
  writeFileSync(join(root, "invalid.jsonl"), before.toString().replace('"context_reset"', '"unknown"'));
  assert.throws(() => scanAttachmentReferences(root), /invalid session entry type/);
});

test("legacy reset: interrupted tools before reset are not repaired into the new context", t => {
  const call: SessionEntry = { ...base(1), entryType: "assistant_message", payload: { requestId: "req", finishReason: "tool-calls",
    message: { role: "assistant", provider: "fake", model: "test", content: [{ type: "tool-call", call: { id: "old-call", name: "read", arguments: "{}" } }] } } };
  const { path } = fixture(t, [call, reset(2), user(3, "new"), { ...call, ...base(4), payload: { ...call.payload, message: { ...call.payload.message, content: [{ type: "tool-call", call: { id: "new-call", name: "read", arguments: "{}" } }] } } }]);
  assert.deepEqual(readSessionFile(path).openToolCalls.map(call => call.toolCallId), ["new-call"]);
});

test("legacy reset: fork and clone remap reset boundaries when diagnostic records are omitted", t => {
  const { root } = fixture(t, [user(1, "old"), { ...base(2), kind: "record", recordType: "turn_finished", payload: {} },
    { ...base(3), kind: "record", recordType: "turn_finished", payload: {} }, reset(4), user(5, "new")]);
  const manager = new SessionManager({ sessionsRoot: root, appVersion: "test" });
  const clone = manager.clone({ parentSessionId: "legacy" });
  const fork = manager.fork({ parentSessionId: "legacy", entryId: "e5", mode: "at" });
  for (const { path } of [clone, fork]) {
    const entries = readSessionFile(path).items.filter(item => item.kind === "entry");
    assert.deepEqual(build(entries).messages.map(message => message.content), ["new"]);
    const marker = entries.find(entry => entry.entryType === "context_reset");
    assert.equal(marker?.payload.resetThroughSeq, 1);
  }
});

test("legacy reset: token estimates do not reuse usage from cleared context", () => {
  const entries = [user(1, "old"), reset(2), user(3, "new")];
  const measured = new DefaultTokenEstimator().measure({
    entries, messages: build(entries).messages, tools: [], provider: "fake", model: "test",
    systemFingerprint: "s", projectInstructionsFingerprint: "p", toolsFingerprint: "t",
    anchor: { throughEntryId: "e1", throughSeq: 1, contextTokens: 10000, provider: "fake", model: "test",
      systemFingerprint: "s", projectInstructionsFingerprint: "p", toolsFingerprint: "t" },
  });
  assert.equal(measured.source, "estimated");
  assert.ok(measured.totalTokens < 10000);
});
