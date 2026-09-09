import assert from "node:assert/strict";
import test from "node:test";
import { CodingAgent, AgentCancelled } from "../packages/core/agent-runtime/src/index.ts";
import { ToolRegistry, type ToolAdapterDefinition } from "../packages/core/tools/src/index.ts";
import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import type { ModelAdapter, ModelRequest, ModelResult } from "@laohuang/llm";
import { createMcpService } from "../packages/core/mcp/src/index.ts";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";

function definition(name: string, execute: ToolAdapterDefinition["execute"]): ToolAdapterDefinition {
  return { spec: { name, description: name, parameters: { type: "object" }, promptGuidelines: [] }, execute };
}
function response(request: ModelRequest, tool?: string): ModelResult {
  return { requestId: request.requestId, finishReason: tool ? "tool-calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 },
    message: { role: "assistant", provider: "test", model: "test", content: tool
      ? [{ type: "tool-call", call: { id: "call", name: tool, arguments: "{}" } }]
      : [{ type: "text", text: "done" }] } };
}

test("next model step sees the latest tools and shares its snapshot with governor and execution", async () => {
  const registry = new ToolRegistry([]);
  const requests: ModelRequest[] = [];
  const budgets: unknown[] = [];
  let actualSignal: AbortSignal | undefined;
  registry.replaceOwner("mcp:test", [definition("first", (_args, context) => {
    actualSignal = context.signal;
    registry.replaceOwner("mcp:test", [definition("second", () => ({ ok: true }))]);
    return { ok: true };
  })]);
  const adapter: ModelAdapter = { name: "fixture", runAttempt: async request => {
    requests.push(request); return response(request, requests.length === 1 ? "first" : undefined);
  } };
  const token = new CancelToken();
  const agent = new CodingAgent({ modelAdapter: adapter, tools: registry, provider: "test", model: "test",
    contextGovernor: { prepare: async input => { budgets.push(input.tools); return { messages: input.messages }; } } });
  assert.equal(await agent.run("go", null, { cancelToken: token }), "done");
  assert.deepEqual(requests.map(r => r.tools.map(t => t.name)), [["first"], ["second"]]);
  assert.deepEqual(budgets, requests.map(r => r.tools));
  assert.equal(actualSignal, token.signal);
});

test("a revoked tool returned by an in-flight model request cannot execute its replacement", async () => {
  const registry = new ToolRegistry([]);
  let calls = 0;
  registry.replaceOwner("mcp:test", [definition("remote", () => { calls++; return { ok: true }; })]);
  let requests = 0;
  const adapter: ModelAdapter = { name: "fixture", runAttempt: async request => {
    if (++requests === 1) {
      registry.replaceOwner("mcp:test", [definition("remote", () => { calls++; return { ok: true }; })]);
      return response(request, "remote");
    }
    return response(request);
  } };
  const agent = new CodingAgent({ modelAdapter: adapter, tools: registry, provider: "test", model: "test" });
  await agent.run("go");
  assert.equal(calls, 0);
  const result = agent.messages.find(message => message.role === "tool-result");
  assert.ok(result && typeof result.content === "string" && result.content.includes("tool_unavailable"));
  assert.deepEqual(agent.messages.map(message => message.role), ["system", "user", "assistant", "tool-result", "assistant"]);
});

test("cancelling initial tool preparation commits input but never sends a model request", async () => {
  const token = new CancelToken();
  let called = false;
  const agent = new CodingAgent({ modelAdapter: { name: "fixture", runAttempt: async request => { called = true; return response(request); } },
    tools: new ToolRegistry([]), provider: "test", model: "test", prepareTools: async signal => {
      assert.equal(signal, token.signal); token.cancel("test"); signal?.throwIfAborted();
    } });
  await assert.rejects(agent.run("go", null, { cancelToken: token }), AgentCancelled);
  assert.equal(called, false);
  assert.deepEqual(agent.messages.map(message => message.role), ["system", "user"]);
});

test("MCP discovery, model call, SDK execution and history form a complete local round trip", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http" });
  const registry = new ToolRegistry([]);
  const service = createMcpService({ servers: [{ id: "local", sourcePath: "/config", config: fixture.config }], projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
    credentials: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: () => {} });
  let rounds = 0;
  const agent = new CodingAgent({ tools: registry, model: "test", provider: "test", prepareTools: signal => service.waitUntilReady(signal),
    modelAdapter: { name: "fixture", runAttempt: async request => {
      if (++rounds === 1) { assert.equal(request.tools.length, 1); return response(request, request.tools[0]!.name); }
      const result = request.messages.find(message => message.role === "tool-result");
      assert.ok(result && typeof result.content === "string");
      assert.deepEqual(JSON.parse(result.content), { ok: true, status: "completed", content: "{}" });
      return response(request);
    } } });
  try { assert.equal(await agent.run("use MCP"), "done"); assert.equal(fixture.calls(), 1); }
  finally { await service.close(); await fixture.close(); }
});
