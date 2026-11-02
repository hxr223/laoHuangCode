import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodingAgent } from "@laohuang/agent-runtime";
import { ToolRegistry, withCodeModeMetadata, type CodeModeResultMetadata } from "@laohuang/tools";
import { ConversationHistory, ContextBuilder } from "@laohuang/session-context";
import * as sessions from "@laohuang/session-store";
import { validatePiToolArguments } from "@laohuang/llm-pi-ai";

test("individually valid concurrent store deltas cannot overflow the committed branch", () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-store-capacity-"));
  let journal = sessions.createSessionJournal({ sessionsRoot: root, projectRoot: root, initialCwd: root,
    appVersion: "test", provider: "test", model: "test" });
  const path = journal.path;
  try {
    const append = (id: string, set: Record<string, string>) => journal.appendEntry({ entryType: "tool_result", payload: {
      requestId: id, message: { role: "tool-result", toolCallId: id, toolName: "codemode", content: "ok", isError: false },
      codeMode: { storeWrites: { set, delete: [] } },
    } });
    const value = "x".repeat(200000);
    append("first", { a: value, b: value, c: value });
    journal.close(); journal = sessions.createSessionJournal({ sessionsRoot: root, path, header: journal.header });
    const before = journal.nextSeq;
    assert.throws(() => append("second", { d: value, e: value, f: value }), /capacity/i);
    assert.equal(journal.nextSeq, before);
    assert.deepEqual(Object.keys(sessions.projectCodeModeStore(sessions.readSessionFile(path).items.filter(item => item.kind === "entry"))), ["a", "b", "c"]);
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a root result commits script state atomically without putting it in model history", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-store-"));
  const journal = sessions.createSessionJournal({ sessionsRoot: root, projectRoot: root, initialCwd: root,
    appVersion: "test", provider: "test", model: "test" });
  try {
    const history = ConversationHistory.fromReplay(sessions.readSessionFile(journal.path), journal);
    let requests = 0;
    const agent = new CodingAgent({ provider: "test", model: "test", codeMode: "only", conversationHistory: history,
      validateToolArguments: validatePiToolArguments,
      tools: new ToolRegistry([{ spec: { name: "codemode", description: "script", parameters: { type: "object" }, promptGuidelines: [],
        exposure: "model-only", executionRole: "orchestrator" },
        execute: () => withCodeModeMetadata({ ok: true, content: "summary" }, { storeWrites: { set: { value: "PRIVATE_STORE_VALUE" }, delete: [] } }),
      }]),
      modelAdapter: { name: "fake", runAttempt: async request => {
        const tool = ++requests === 1;
        return { requestId: request.requestId!, finishReason: tool ? "tool-calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 },
          message: { role: "assistant", provider: "test", model: "test", content: tool
            ? [{ type: "tool-call", call: { id: "root-call", name: "codemode", arguments: "{}" } }]
            : [{ type: "text", text: "done" }] } };
      } },
    });
    await agent.run("go");
    journal.flush();
    const entries = sessions.readSessionFile(journal.path).items.filter(item => item.kind === "entry");
    assert.deepEqual(sessions.projectCodeModeStore(entries), { value: "PRIVATE_STORE_VALUE" });
    assert.deepEqual(sessions.projectCodeModeStore(history.entries()), { value: "PRIVATE_STORE_VALUE" });
    const results = entries.filter(entry => entry.entryType === "tool_result");
    assert.equal(results.length, 1);
    assert.ok(results[0]?.payload.codeMode?.storeWrites);
    assert.ok(!JSON.stringify(agent.messages).includes("PRIVATE_STORE_VALUE"));
    const built = new ContextBuilder().build({ entries, currentProvider: "test", currentModel: "test" });
    assert.ok(!JSON.stringify(built.messages).includes("PRIVATE_STORE_VALUE"));
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed root cannot persist state writes or advance the journal", () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-store-failed-"));
  const journal = sessions.createSessionJournal({ sessionsRoot: root, projectRoot: root, initialCwd: root,
    appVersion: "test", provider: "test", model: "test" });
  try {
    const history = ConversationHistory.fromReplay(sessions.readSessionFile(journal.path), journal);
    const before = journal.nextSeq;
    assert.throws(() => history.appendToolResults({ requestId: "failed", recovered: false,
      messages: [{ role: "tool-result", toolCallId: "failed", toolName: "codemode", content: "failed", isError: true }],
      codeModeByCallId: { failed: { storeWrites: { set: { count: 99 }, delete: [] } } },
    }), /store.*success/i);
    assert.equal(journal.nextSeq, before);
    assert.deepEqual(sessions.projectCodeModeStore(history.entries()), {});
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("invalid persisted state is rejected before appending a root result", () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-store-invalid-"));
  const journal = sessions.createSessionJournal({ sessionsRoot: root, projectRoot: root, initialCwd: root,
    appVersion: "test", provider: "test", model: "test" });
  try {
    const history = ConversationHistory.fromReplay(sessions.readSessionFile(journal.path), journal);
    for (const metadata of [null, [], { storeWrites: { set: [], delete: [] } },
      { storeWrites: { set: { x: "x".repeat(262144) }, delete: [] } },
      { storeWrites: { set: {}, delete: [1] } }, { storeWrites: { set: { x: 1 }, delete: ["x"] } }]) {
      const before = journal.nextSeq;
      assert.throws(() => history.appendToolResults({ requestId: "root", recovered: false,
        messages: [{ role: "tool-result", toolCallId: "root", toolName: "codemode", content: "ok", isError: false }],
        codeModeByCallId: { root: metadata as unknown as CodeModeResultMetadata },
      }), /store|metadata/i);
      assert.equal(journal.nextSeq, before);
    }
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("fork inherits state at its branch point while clone and compaction keep the latest state", () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-store-fork-"));
  const manager = new sessions.SessionManager({ sessionsRoot: root, appVersion: "test" });
  const opened = manager.create({ projectRoot: root, initialCwd: root, provider: "test", model: "test", reasoningEffort: "off" });
  try {
    const history = ConversationHistory.fromReplay(opened.replay, opened.journal);
    const write = (id: string, count: number) => {
      history.appendAssistant({ requestId: id, finishReason: "tool-calls", message: { role: "assistant", provider: "test", model: "test",
        content: [{ type: "tool-call", call: { id, name: "codemode", arguments: "{}" } }] } });
      history.appendToolResults({ requestId: id, recovered: false,
        messages: [{ role: "tool-result", toolCallId: id, toolName: "codemode", content: "ok", isError: false }],
        codeModeByCallId: { [id]: { storeWrites: { set: { count }, delete: [] } } },
      });
    };
    history.appendUser({ message: { role: "user", content: "first" }, inputEventIds: [], source: "direct" });
    write("first", 1);
    const branchPoint = history.appendUser({ message: { role: "user", content: "branch point" }, inputEventIds: [], source: "direct" });
    write("second", 2);
    history.appendCompaction({ summary: "a summary without script state", summarizedFromSeq: 1, summarizedThroughSeq: branchPoint.seq,
      retainedFromSeq: branchPoint.seq + 1, tokensBefore: 100, retainedTokens: 10, summaryInputTokens: 5, summaryOutputTokens: 5,
      provider: "test", model: "test", trigger: "manual" });
    opened.journal.close();
    const fork = manager.fork({ parentSessionId: opened.header.sessionId, entryId: branchPoint.id, mode: "before" });
    const clone = manager.clone({ parentSessionId: opened.header.sessionId });
    const entries = (path: string) => sessions.readSessionFile(path).items.filter(item => item.kind === "entry");
    assert.deepEqual(sessions.projectCodeModeStore(entries(fork.path)), { count: 1 });
    assert.deepEqual(sessions.projectCodeModeStore(entries(clone.path)), { count: 2 });
    assert.deepEqual(sessions.projectCodeModeStore(entries(opened.journal.path)), { count: 2 });
  } finally { opened.journal.close(); rmSync(root, { recursive: true, force: true }); }
});
