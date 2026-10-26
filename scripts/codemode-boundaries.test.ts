import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, ToolRuntime, ToolSelection, withTouchedPath, type ToolAdapterDefinition, type ToolExecutionContextLike } from "@laohuang/tools";
import { CancelToken, EventFactory, EventProjector } from "@laohuang/runtime-protocol";
import { CodingAgent } from "@laohuang/agent-runtime";
import { validatePiToolArguments } from "@laohuang/llm-pi-ai";
import { ConversationHistory, ContextBuilder, serializeConversation } from "@laohuang/session-context";
import { createSessionJournal, readSessionFile, projectTranscript } from "@laohuang/session-store";
import type { ModelRequest, ModelResult } from "@laohuang/llm";
import { ConfigManager } from "@laohuang/local-config";
import { TranscriptStore } from "../packages/terminal/tui/src/tui/transcript-store.ts";
import { Transcript } from "../packages/terminal/tui/src/tui/components/transcript.ts";
import { DEFAULT_DARK_THEME } from "../packages/terminal/tui/src/tui/theme.ts";

function tool(name: string, execute: ToolAdapterDefinition["execute"] = () => ({ ok: true }), spec: Partial<ToolAdapterDefinition["spec"]> = {}): ToolAdapterDefinition {
  return { spec: { name, description: name, parameters: { type: "object", additionalProperties: false, properties: {} }, promptGuidelines: [], ...spec }, execute };
}
function orchestrator(execute: ToolAdapterDefinition["execute"]): ToolAdapterDefinition {
  return tool("codemode", execute, { exposure: "model-only", executionRole: "orchestrator" });
}
function reply(request: ModelRequest, name?: string): ModelResult {
  return { requestId: request.requestId ?? "test", finishReason: name ? "tool-calls" : "stop", usage: { inputTokens: 10, outputTokens: 1 },
    message: { role: "assistant", provider: request.provider, model: request.model,
      content: name ? [{ type: "tool-call", call: { id: request.requestId!, name, arguments: "{}" } }] : [{ type: "text", text: "done" }] } };
}

test("only blocks direct tools and search even after loading/restoring; on retains both paths", async () => {
  const registry = new ToolRegistry([orchestrator(() => ({ ok: true })), tool("read"), tool("hidden", undefined, { exposure: "hidden" }),
    tool("script_only", undefined, { exposure: "codemode" }),
    ...Array.from({ length: 20 }, (_, i) => tool(`remote_${i}`, undefined, { exposure: "deferred" }))]);
  const selection = new ToolSelection();
  const on = selection.prepare(registry, "on");
  selection.apply(on.update);
  await on.directTools.execute("tool_search", { query: "remote_0", limit: 1 });
  selection.apply({ toolsAdded: on.pending(), toolsRemoved: [] });
  const saved = selection.snapshot();
  const restored = new ToolSelection();
  restored.restore(saved);
  const only = restored.prepare(registry, "only");
  assert.deepEqual(only.declaredTools.map(s => s.name), ["codemode"]);
  for (const name of ["remote_0", "read", "tool_search", "script_only", "hidden"]) assert.equal((await only.directTools.execute(name, {})).ok, false);
  for (const name of ["remote_0", "read", "script_only"]) assert.equal((await only.callableTools.execute(name, {})).ok, true);
  for (const name of ["codemode", "tool_search", "hidden"]) assert.equal((await only.callableTools.execute(name, {})).ok, false);
  assert.deepEqual(only.update, { toolsAdded: [], toolsRemoved: [] });
  assert.deepEqual(restored.snapshot(), saved);
  assert.ok(restored.prepare(registry, "on").declaredTools.some(s => s.name === "remote_0"));
  assert.ok(!restored.prepare(registry).declaredTools.some(s => s.name === "codemode"));
  assert.equal(restored.prepare(registry).callableTools.definitions.length, 0);
});

test("nested calls validate, serialize exclusive leaves, drain unawaited work, and close their capability", { timeout: 2000 }, async () => {
  const order: string[] = [];
  let captured: ToolExecutionContextLike | undefined;
  const registry = new ToolRegistry([
    orchestrator(async (_, context) => {
      captured = context;
      const invalid = await context.executeTool!("write", { count: "wrong" });
      assert.equal(invalid.ok, false);
      void context.executeTool!("write", { count: "2" });
      void context.executeTool!("read", {});
      return { ok: true, content: "summary" };
    }),
    tool("write", async args => {
      assert.equal(args.count, 2);
      order.push("write start");
      await new Promise(resolve => setTimeout(resolve, 10));
      order.push("write end");
      return withTouchedPath({ ok: true, content: "PRIVATE DATA" }, "/tmp/nested.txt");
    }, { parameters: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] } }),
    tool("read", () => { order.push("read"); return { ok: true }; }),
  ]);
  const selected = new ToolSelection().prepare(registry, "only");
  const events: string[] = [];
  const runtime = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments });
  const batch = await runtime.execute({ registry: selected.directTools, callableTools: selected.callableTools,
    toolCalls: [{ id: "parent", name: "codemode", arguments: "{}" }], executionMode: "sequential", cancelToken: null,
    onToolResult: event => events.push(event.parentToolCallId ?? "root") });
  assert.deepEqual(order, ["write start", "write end", "read"]);
  assert.deepEqual(batch.results, [{ ok: true, content: "summary" }]);
  assert.deepEqual(batch.touchedPaths, ["/tmp/nested.txt"]);
  assert.deepEqual(events, ["parent", "parent", "parent", "root"]);
  assert.equal((await captured!.executeTool!("read", {})).status, "scope_closed");
});

test("parent cancellation reaches running children and prevents queued leaf execution", { timeout: 2000 }, async () => {
  const token = new CancelToken();
  let secondRan = false;
  const registry = new ToolRegistry([
    orchestrator(async (_, ctx) => {
      const results = await Promise.all([ctx.executeTool!("write", {}), ctx.executeTool!("read", {})]);
      assert.equal(results[1]?.status, "cancelled");
      return { ok: false, status: "cancelled" };
    }),
    tool("write", async (_, ctx) => {
      assert.equal(ctx.signal, token.signal);
      await new Promise(resolve => setTimeout(resolve, 5));
      token.cancel("stop nested");
      return { ok: false, status: "cancelled" };
    }),
    tool("read", () => { secondRan = true; return { ok: true }; }),
  ]);
  const selected = new ToolSelection().prepare(registry, "only");
  await new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).execute({
    registry: selected.directTools, callableTools: selected.callableTools, toolCalls: [{ id: "p", name: "codemode", arguments: "{}" }], executionMode: "parallel", cancelToken: token,
  });
  assert.equal(secondRan, false);
});

test("a model-step mode snapshot survives switching during the model request", async () => {
  let readCalls = 0;
  const requests: ModelRequest[] = [];
  const agent = new CodingAgent({ tools: new ToolRegistry([tool("read", () => { readCalls++; return { ok: true }; }), orchestrator(() => ({ ok: true }))]),
    codeMode: "on", provider: "test", model: "test", validateToolArguments: validatePiToolArguments,
    modelAdapter: { name: "fake", runAttempt: async request => {
      requests.push(request);
      if (requests.length === 1) { agent.setCodeMode("only"); return reply(request, "read"); }
      if (requests.length === 2) return reply(request, "read");
      return reply(request);
    } } });
  await agent.run("test");
  assert.equal(readCalls, 1, "the old batch may finish, the next direct call must be rejected");
  assert.deepEqual(requests.map(r => r.tools.map(t => t.name)), [["read", "codemode"], ["codemode"], ["codemode"]]);
  assert.match(String(requests[2]?.messages.at(-1)?.content), /unavailable/);
});

test("nested records survive replay, are redacted, and never become model history or compaction output", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-history-"));
  const journal = createSessionJournal({ sessionsRoot: root, projectRoot: root, initialCwd: root, appVersion: "test", provider: "test", model: "test", reasoningEffort: "off", origin: "new" });
  try {
    const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
    history.appendSystemContext({ message: { role: "system", content: "system" }, cwd: root });
    let requests = 0;
    const agent = new CodingAgent({ tools: new ToolRegistry([
      orchestrator(async (_, ctx) => { await ctx.executeTool!("read", { password: "private-token" }); return { ok: true, content: "100" }; }),
      tool("read", () => ({ ok: true, content: "PRIVATE RAW DATA" }), { parameters: { type: "object", properties: { password: { type: "string" } } } }),
    ]), codeMode: "only", provider: "test", model: "test", validateToolArguments: validatePiToolArguments, conversationHistory: history,
      modelAdapter: { name: "fake", runAttempt: async request => reply(request, ++requests === 1 ? "codemode" : undefined) } });
    await agent.run("go");
    journal.flush();
    const replay = readSessionFile(journal.path);
    assert.deepEqual(replay.openToolCalls, []);
    const entries = replay.items.filter(item => item.kind === "entry");
    const results = entries.filter(entry => entry.entryType === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.payload.executions?.[0]?.arguments.password, "[REDACTED]");
    assert.ok(!JSON.stringify(results).includes("PRIVATE RAW DATA"));
    const built = new ContextBuilder().build({ entries, currentProvider: "test", currentModel: "test" });
    assert.equal(built.messages.filter(m => m.role === "tool-result").length, 1);
    assert.ok(!JSON.stringify(built.messages).includes("parentToolCallId"));
    assert.ok(!serializeConversation(entries).includes("parentToolCallId"));
    assert.ok(!serializeConversation(entries).includes("PRIVATE RAW DATA"));
    assert.ok(built.messages.some(m => m.role === "system" && m.toolMode === "only"));
    const store = new TranscriptStore();
    store.replace(projectTranscript(entries));
    const transcript = new Transcript({ blocks: store.blocks() });
    const render = () => transcript.render({ width: 100, theme: DEFAULT_DARK_THEME }).lines.map(line => line.spans.map(s => s.text).join("")).join("\n");
    assert.match(render(), /1 tool calls/);
    assert.ok(!render().includes("● read"));
    store.setToolOutputExpanded(true);
    assert.match(render(), /● read/);
    assert.ok(!render().includes("private-token"));
  } finally { journal.close(); rmSync(root, { recursive: true, force: true }); }
});

test("nested Bash logs retain lineage and diagnostics without output bodies", () => {
  const event = new EventFactory().create("tool.finished", { source: "tool", session_id: "s", task_id: "t", correlation_id: "child",
    payload: { status: "failed", parentToolCallId: "parent", rootToolCallId: "parent", stdout: "PRIVATE RAW DATA", stderr: "PRIVATE ERROR OUTPUT", result: { ok: false, content: "RAW", error: "password=secret" } } });
  const projected = new EventProjector().project(event, "log");
  assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
  assert.ok(!JSON.stringify(projected).includes('"RAW"'));
  assert.ok(!JSON.stringify(projected).includes("password=secret"));
  assert.match(JSON.stringify(projected), /parentToolCallId/);
});

test("global Code Mode default validates and persists independently of model profiles", () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-config-"));
  try {
    const config = new ConfigManager(join(root, "config.json"));
    assert.equal(config.getCodeMode(), "off");
    config.setCodeMode("only");
    config.configure({ name: "test", provider: "test", model: "test", baseUrl: null });
    assert.equal(new ConfigManager(config.path).getCodeMode(), "only");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live TUI keeps nested stream output under its parent and invalidates the group render", () => {
  const store = new TranscriptStore();
  const update = (kind: string, correlationId: string, payload: Record<string, unknown>, text = "", stream = "") =>
    store.apply({ kind, correlationId, payload, text, stream });
  update("tool.started", "parent", { name: "codemode", arguments: {} });
  update("tool.started", "child", { name: "bash", arguments: { command: "pwd" }, parentToolCallId: "parent" });
  const transcript = new Transcript({ blocks: store.blocks() });
  const render = () => transcript.render({ width: 100, theme: DEFAULT_DARK_THEME }).lines.map(line => line.spans.map(s => s.text).join("")).join("\n");
  assert.equal(store.blocks().length, 1);
  assert.ok(!render().includes("● bash"));
  store.setToolOutputExpanded(true);
  assert.match(render(), /Running/);
  update("tool.output_delta", "child", {}, "streaming output", "stdout");
  assert.match(render(), /streaming output/);
  update("tool.finished", "child", { status: "failed", duration_ms: 12, result: { ok: false, error: "failed command" } });
  assert.match(render(), /failed command/);
  assert.match(render(), /12ms/);
  update("tool.finished", "parent", { status: "completed", result: { ok: true, content: "summary" } });
  store.setToolOutputExpanded(false);
  assert.match(render(), /summary/);
  assert.ok(!render().includes("streaming output"));
});

test("nested dynamic tool revocation cannot execute an obsolete binding", async () => {
  let called = false;
  const registry = new ToolRegistry([orchestrator(async (_, ctx) => {
    registry.removeOwner("dynamic");
    return await ctx.executeTool!("remote", {});
  })]);
  registry.replaceOwner("dynamic", [tool("remote", () => { called = true; return { ok: true }; }, { exposure: "deferred" })]);
  const selected = new ToolSelection().prepare(registry.snapshot(), "only");
  const result = await new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).execute({
    registry: selected.directTools, callableTools: selected.callableTools, toolCalls: [{ id: "p", name: "codemode", arguments: "{}" }], executionMode: "parallel", cancelToken: null,
  });
  assert.equal(called, false);
  assert.equal(result.results[0]?.status, "tool_unavailable");
});

test("nested attachments are lifted to the root result while raw text stays inside the script", async () => {
  const attachment = { type: "file" as const, ref: { id: `sha256:${"a".repeat(64)}` as const, name: "report.txt", bytes: 3 } };
  const registry = new ToolRegistry([
    orchestrator(async (_, ctx) => { await ctx.executeTool!("read", {}); return { ok: true, content: "summary" }; }),
    tool("read", () => ({ ok: true, content: "PRIVATE", attachmentContent: [attachment] })),
  ]);
  const selected = new ToolSelection().prepare(registry, "only");
  const result = await new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).execute({
    registry: selected.directTools, callableTools: selected.callableTools, toolCalls: [{ id: "p", name: "codemode", arguments: "{}" }], executionMode: "parallel", cancelToken: null,
  });
  assert.equal(result.results[0]?.content, "summary");
  assert.deepEqual(result.results[0]?.attachmentContent, [attachment]);
});

test("nested touched paths discover descendant project instructions before the next model step", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemode-instructions-"));
  try {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "AGENTS.md"), "Always preserve the nested fixture invariant.");
    const requests: ModelRequest[] = [];
    const agent = new CodingAgent({ projectRoot: root, startupCwd: root, provider: "test", model: "test", codeMode: "only",
      tools: new ToolRegistry([
        orchestrator(async (_, ctx) => { await ctx.executeTool!("read", {}); return { ok: true, content: "done" }; }),
        tool("read", () => withTouchedPath({ ok: true, content: "PRIVATE" }, join(realpathSync(root), "sub", "file.txt"))),
      ]), validateToolArguments: validatePiToolArguments,
      modelAdapter: { name: "fake", runAttempt: async request => { requests.push(request); return reply(request, requests.length === 1 ? "codemode" : undefined); } },
    });
    await agent.run("go");
    assert.ok(requests[1]?.messages.some(message => message.role === "user" && message.content.includes("nested fixture invariant")));
    assert.ok(!JSON.stringify(requests[1]?.messages).includes("PRIVATE"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
