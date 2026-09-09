import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgent } from "../packages/core/agent-runtime/src/index.ts";
import { ToolRegistry, ToolSelection, type ToolAdapterDefinition } from "../packages/core/tools/src/index.ts";
import { ConversationHistory, ContextBuilder, ContextGovernor, DefaultTokenEstimator } from "@laohuang/session-context";
import { createSessionJournal, readSessionFile } from "@laohuang/session-store";
import { toPiContext } from "../packages/llm/llm-pi-ai/src/index.ts";
import type { ModelRequest, ModelResult } from "@laohuang/llm";

function registry(schemaSize = 0) {
  const definition = (name: string, deferred: boolean): ToolAdapterDefinition => ({
    spec: { name, description: name, parameters: { type: "object", properties: { value: { type: "string", description: name === "remote_0" ? "x".repeat(schemaSize) : "value" } } }, promptGuidelines: [],
      ...(deferred ? { catalog: { source: "mcp:fixture", originalName: name, binding: "stable", exposure: "deferred" as const } } : {}) },
    execute: () => ({ ok: true, content: "executed" }),
  });
  const tools = new ToolRegistry(["read", "write", "edit", "bash"].map(name => definition(name, false)));
  tools.replaceOwner("mcp:fixture", Array.from({ length: 16 }, (_, i) => definition(`remote_${i}`, true)));
  return tools;
}

function reply(request: ModelRequest, name?: string, args: Record<string, unknown> = {}): ModelResult {
  return { requestId: request.requestId, finishReason: name ? "tool-calls" : "stop", usage: { inputTokens: 10, outputTokens: 2 },
    message: { role: "assistant", provider: request.provider, model: request.model,
      content: name ? [{ type: "tool-call", call: { id: request.requestId!, name, arguments: JSON.stringify(args) } }] : [{ type: "text", text: "done" }] } };
}

function session() {
  const root = mkdtempSync(join(tmpdir(), "laohuang-tool-search-"));
  const journal = createSessionJournal({ sessionsRoot: root, projectRoot: "/tmp/project", initialCwd: "/tmp/project", appVersion: "test", provider: "test", model: "test", reasoningEffort: "off", origin: "new" });
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
  history.appendSystemContext({ message: { role: "system", content: "system" }, cwd: "/tmp/project" });
  const build = () => new ContextBuilder().build({ entries: history.entries(), currentProvider: "test", currentModel: "test" }).messages;
  return { root, journal, history, build, close() { journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("search loads once, projects schema only into wire tools, and survives journal replay", async () => {
  const state = session();
  const tools = registry();
  const requests: ModelRequest[] = [];
  const agent = new CodingAgent({ tools, provider: "test", model: "test", conversationHistory: state.history,
    modelAdapter: { name: "fake", runAttempt: async request => {
      requests.push(request);
      if (requests.length === 1) return reply(request, "tool_search", { query: "remote_0", limit: 1 });
      if (requests.length === 2) return reply(request, "remote_0");
      return reply(request);
    } } });
  agent.messages = [...state.build()];
  try {
    await agent.run("go");
    assert.deepEqual(requests.map(r => r.tools.length), [5, 6, 6]);
    assert.equal(state.history.entries().filter(e => e.entryType === "tool_definitions").length, 1);
    assert.equal(state.history.entries().filter(e => e.entryType === "tool_catalog").length, 1);
    const wire = toPiContext(requests[2]!);
    assert.equal(wire.systemPrompt, "system");
    assert.equal(wire.messages.length, requests[2]!.messages.length - 2);
    assert.equal(wire.tools?.length, 6);
    assert.ok(!JSON.stringify(wire).includes('"binding"'));
    const estimator = new DefaultTokenEstimator();
    const internal = requests[2]!.messages.filter(m => m.role === "system" && m.toolDefinitions);
    assert.equal(estimator.estimateMessages(internal), 0);
    assert.equal(estimator.estimateTools(requests[2]!.tools), estimator.estimateTools(requests[2]!.tools.map(t => ({ ...t, catalog: undefined, promptGuidelines: ["not sent"] }))));
    const replay = readSessionFile(state.journal.path);
    assert.deepEqual(replay.openToolCalls, []);
    const restored = ConversationHistory.fromReplay(replay, state.journal);
    const messages = new ContextBuilder().build({ entries: restored.entries(), currentProvider: "other", currentModel: "other" }).messages;
    const selection = new ToolSelection().prepare(tools, messages.map(m => m.role === "system" || m.role === "user" ? m : {}));
    assert.equal(selection.announcement, undefined);
    assert.ok(selection.view.definitions.some(t => t.name === "remote_0"));
  } finally { state.close(); }
});

test("compaction retains call/result/definitions together, then unloads when that unit leaves context", async () => {
  const state = session();
  const tools = registry();
  let round = 0;
  const agent = new CodingAgent({ tools, provider: "test", model: "test", conversationHistory: state.history,
    modelAdapter: { name: "fake", runAttempt: async request => ++round === 1 ? reply(request, "tool_search", { query: "remote_0", limit: 1 }) : reply(request) } });
  agent.messages = [...state.build()];
  const governor = new ContextGovernor({ summarize: async () => ({ summary: "used remote_0", inputTokens: 1, outputTokens: 1 }), appendCompaction: p => state.history.appendCompaction(p) });
  const compact = () => governor.compact({ entries: state.history.entries(), currentProvider: "test", currentModel: "test", tools: [], budget: { contextWindow: 10000, maxOutputTokens: 1000 },
    policy: { auto: true, thresholdRatio: 0.8, retainRatio: 0.1, retainTokens: 1, maxSummaryTokens: 100, safetyRatio: 0.05 }, trigger: "manual" });
  try {
    await agent.run("go");
    // The later assistant answer is retained; the completed search unit is removed whole.
    await compact();
    const retained = state.build();
    assert.equal(retained.some(m => m.role === "system" && m.toolDefinitions), false);
    const selected = new ToolSelection().prepare(tools, retained.map(m => m.role === "system" || m.role === "user" ? m : {}));
    assert.ok(!selected.view.definitions.some(t => t.name === "remote_0"));
    assert.match(selected.announcement!.content, /tools_added/);
    assert.equal((await selected.view.execute("tool_search", { query: "remote_0", limit: 1 })).ok, true);
    assert.equal(selected.pending().length, 1);
  } finally { state.close(); }
});

for (const schemaSize of [26000, 90000]) {
  test(`search preflight compacts old history and ${schemaSize === 26000 ? "loads a fitting" : "rejects an oversized"} definition`, async () => {
    const state = session();
    const tools = registry(schemaSize);
    state.history.appendUser({ message: { role: "user", content: "old history ".repeat(1500) }, inputEventIds: [], source: "direct" });
    let round = 0, preflights = 0;
    const requests: ModelRequest[] = [];
    const governor = new ContextGovernor({ summarize: async () => ({ summary: "summary", inputTokens: 1, outputTokens: 1 }), appendCompaction: p => state.history.appendCompaction(p) });
    const agent = new CodingAgent({ tools, provider: "test", model: "test", conversationHistory: state.history,
      contextGovernor: { prepare: async input => {
        const entries = state.history.entries();
        const pending = input.pendingToolCall ? [...entries].reverse().find(e => e.entryType === "assistant_message") : undefined;
        if (input.pendingToolCall) preflights++;
        const prepared = await governor.prepare({ entries: entries.filter(e => e !== pending), currentProvider: "test", currentModel: "test", tools: input.tools,
          projectTools: input.projectTools, reserveTokens: input.reserveTokens,
          budget: { contextWindow: 12000, maxOutputTokens: 1000 },
          policy: { auto: true, thresholdRatio: 0.9, retainRatio: 0.1, retainTokens: 100, maxSummaryTokens: 100, safetyRatio: 0.02 } });
        return { messages: prepared.messages, contextTokens: prepared.tokens, hardInputLimit: 11000, contextWindow: 12000 };
      } },
      modelAdapter: { name: "fake", runAttempt: async request => {
        requests.push(request);
        return ++round === 1 ? reply(request, "tool_search", { query: "remote_0", limit: 1 }) : reply(request);
      } } });
    agent.messages = [...state.build()];
    try {
      await agent.run("load");
      assert.equal(preflights, 1);
      const result = agent.messages.find(m => m.role === "tool-result");
      assert.ok(result && result.role === "tool-result");
      assert.equal(JSON.parse(result.content).matches[0].status, schemaSize === 26000 ? "loaded" : "not_loaded_budget");
      assert.equal(requests[1]!.tools.some(t => t.name === "remote_0"), schemaSize === 26000);
      assert.ok(state.history.entries().some(e => e.entryType === "compaction"));
    } finally { state.close(); }
  });
}
