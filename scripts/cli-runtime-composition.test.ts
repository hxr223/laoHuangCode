import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type {
  ModelAdapter,
  ModelCatalog,
  ModelInfo,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
} from "@laohuang/llm";
import { ModelError } from "@laohuang/llm";
import { ToolRegistry, type ToolAdapterDefinition } from "@laohuang/tools";

import { createSessionRuntime } from "../apps/cli/src/create-session-runtime.ts";
import { SessionController } from "../apps/cli/src/session-controller.ts";

const models: readonly ModelInfo[] = [
  {
    provider: "test",
    id: "model-a",
    name: "Model A",
    api: "test",
    reasoning: true,
    supportedReasoningEfforts: ["off", "high"],
    input: ["text"],
    contextWindow: 10_000,
    maxTokens: 100,
  },
  {
    provider: "other",
    id: "model-b",
    name: "Model B",
    api: "test",
    reasoning: false,
    supportedReasoningEfforts: ["off"],
    input: ["text"],
    contextWindow: 20_000,
    maxTokens: 200,
  },
];

test("CLI runtime injects SDK validation and lets the model correct a rejected call", async (t) => {
  const { root, controller } = await fixture(t);
  const executed: Record<string, unknown>[] = [];
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = {
    name: "validation-fixture",
    async runAttempt(request) {
      requests.push(request);
      const round = requests.length;
      if (round === 2) {
        const result = request.messages.at(-1);
        assert.ok(result?.role === "tool-result" && result.isError);
        assert.equal(result.toolCallId, "call-1");
        assert.match(result.content, /limit/);
        assert.equal(executed.length, 0);
      }
      if (round === 3) {
        const result = request.messages.at(-1);
        assert.ok(result?.role === "tool-result" && !result.isError);
        assert.equal(result.toolCallId, "call-2");
      }
      return {
        requestId: request.requestId ?? "",
        finishReason: round < 3 ? "tool-calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: { role: "assistant", provider: request.provider, model: request.model, content: round < 3
          ? [{ type: "tool-call", call: { id: `call-${round}`, name: "inspect", arguments: JSON.stringify({ limit: round === 1 ? "wrong" : "20" }) } }]
          : [{ type: "text", text: "done" }] },
      };
    },
  };
  const composed = createSessionRuntime({
    modelAdapter: adapter, catalog: new FakeCatalog(), route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([{
      spec: { name: "inspect", description: "Inspect fixture", promptGuidelines: [], parameters: {
        type: "object", required: ["limit"], properties: { limit: { type: "integer", minimum: 1 } },
      } },
      execute: args => { executed.push(args); return { ok: true, content: "fixture" }; },
    }]),
    sessionController: controller, projectRoot: root, startupCwd: root, version: "test",
  });
  try {
    assert.equal(await composed.agent.run("inspect"), "done");
    assert.deepEqual(executed, [{ limit: 20 }]);
    assert.equal(requests.length, 3);
    const results = controller.history!.entries().filter(entry => entry.entryType === "tool_result");
    assert.equal(results.length, 2);
  } finally {
    await composed.session.close({ timeoutMs: 1000 });
    await composed.close();
  }
});

class FakeCatalog implements ModelCatalog {
  listProviders(): readonly ModelProviderInfo[] {
    return [
      { id: "test", name: "Test", authName: "API key", dynamicModels: false, verified: true },
      { id: "other", name: "Other", authName: "API key", dynamicModels: false, verified: true },
    ];
  }

  getProvider(provider: string): ModelProviderInfo | undefined {
    return this.listProviders().find((candidate) => candidate.id === provider);
  }

  listModels(provider: string): readonly ModelInfo[] {
    return models.filter((model) => model.provider === provider);
  }

  async listAvailableModels(provider: string): Promise<readonly ModelInfo[]> {
    return this.listModels(provider);
  }

  getModel(provider: string, model: string): ModelInfo | undefined {
    return models.find((candidate) => candidate.provider === provider && candidate.id === model);
  }

  async refresh(_provider: string): Promise<void> {}
}

class RecordingAdapter implements ModelAdapter {
  readonly name = "recording";
  readonly requests: ModelRequest[] = [];
  #nextRequest = 0;

  async runAttempt(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    this.#nextRequest += 1;
    request.onRequestOpened?.();
    const text = request.reasoningEffort === "off"
      ? "Earlier turns discussed alpha and beta."
      : `reply-${this.#nextRequest}`;
    return {
      requestId: `request-${this.#nextRequest}`,
      message: {
        role: "assistant",
        provider: request.provider,
        model: request.model,
        content: [{ type: "text", text }],
      },
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 6 },
    };
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laohuang-cli-runtime-"));
  const controller = new SessionController({
    sessionsRoot: join(root, "sessions"),
    projectRoot: root,
    initialCwd: root,
    appVersion: "9.8.7",
    provider: "test",
    model: "model-a",
    reasoningEffort: "high",
  });
  await controller.createNew();
  const adapter = new RecordingAdapter();
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, controller, adapter };
}

test("two agent turns use the same persisted conversation history", async (t) => {
  const { root, controller, adapter } = await fixture(t);
  const usage: Array<number | null> = [];
  const composed = createSessionRuntime({
    modelAdapter: adapter,
    catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([]),
    sessionController: controller,
    projectRoot: root,
    startupCwd: root,
    version: "9.8.7",
    presentation: { contextUsageChanged: (value) => usage.push(value.contextTokens) },
  });
  assert.equal(usage.at(-1), 0);

  await composed.session.submitInput("alpha");
  assert.equal(await composed.session.waitForIdle(), true);
  assert.equal(usage.at(-1), 18);
  assert.ok(usage.includes(2), "first user message is estimated before the response");
  await composed.session.submitInput("beta");
  assert.equal(await composed.session.waitForIdle(), true);
  assert.equal(usage.at(-1), 18, "second usage replaces the first rather than accumulating");
  const committed = controller.history!.entries().at(-1)!;
  assert.equal(committed.entryType, "assistant_message");
  if (committed.entryType === "assistant_message") assert.deepEqual(committed.payload.usage, { inputTokens: 12, outputTokens: 6 });

  assert.deepEqual(
    adapter.requests[1]?.messages.slice(-3).map((message) => message.role),
    ["user", "assistant", "user"],
  );
  assert.equal(
    adapter.requests[1]?.messages.at(-3)?.role === "user"
      ? adapter.requests[1].messages.at(-3)?.content
      : null,
    "alpha",
  );
  assert.deepEqual(
    controller.history?.entries().map((entry) => entry.entryType),
    ["system_context", "user_message", "assistant_message", "user_message", "assistant_message"],
  );

  assert.equal(await composed.session.close({ timeoutMs: 1_000 }), true);
  await composed.close();
  assert.equal(controller.currentSessionId, null);
});

test("refreshSession restores resumed history and manual compaction into the agent", async (t) => {
  const { root, controller, adapter } = await fixture(t);
  const snapshots: string[][] = [];
  const usage: Array<number | null> = [];
  const composed = createSessionRuntime({
    modelAdapter: adapter,
    catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([]),
    sessionController: controller,
    projectRoot: root,
    startupCwd: root,
    version: "9.8.7",
    presentation: {
      historyChanged: (entries) => snapshots.push(entries.map((entry) => entry.entryType)),
      contextUsageChanged: (value) => usage.push(value.contextTokens),
    },
  });
  const originalSessionId = controller.currentSessionId!;

  await composed.agent.run("old turn to summarize");
  await composed.agent.run("x".repeat(10_000));
  await composed.agent.run("retain this tail");
  await composed.compact();
  assert.equal(usage.at(-1), null, "summary request usage must not become the conversation baseline");
  assert.equal(controller.history?.entries().at(-1)?.entryType, "compaction");
  assert.ok(composed.agent.messages.some((message) =>
    message.role === "user" && message.content.includes("Earlier turns discussed alpha and beta.")),
  );

  await controller.createNew();
  composed.refreshSession();
  assert.equal(usage.at(-1), 0);
  assert.deepEqual(composed.agent.messages.map((message) => message.role), ["system"]);

  await controller.resume(originalSessionId);
  composed.refreshSession();
  assert.equal(usage.at(-1), null, "resuming must respect the compaction boundary");
  assert.ok(composed.agent.messages.some((message) =>
    message.role === "user" && message.content.includes("Earlier turns discussed alpha and beta.")),
  );
  assert.ok(snapshots.some((snapshot) => snapshot.includes("compaction")));
  await composed.agent.run("continue after compression");
  assert.equal(usage.at(-1), 18);

  await composed.session.close({ timeoutMs: 1_000 });
  await composed.close();
});

test("switchModel updates all model and context routes", async (t) => {
  const { root, controller, adapter } = await fixture(t);
  const usage: Array<{ contextTokens: number | null; contextWindow: number }> = [];
  const composed = createSessionRuntime({
    modelAdapter: adapter,
    catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([]),
    sessionController: controller,
    projectRoot: root,
    startupCwd: root,
    version: "9.8.7",
    presentation: { contextUsageChanged: (value) => usage.push(value) },
  });

  await composed.agent.run("remember this before switching");
  composed.switchModel({ provider: "other", model: "model-b", baseUrl: "https://example.test" });
  assert.equal(usage.at(-1)?.contextTokens, 18);
  await composed.agent.run("use the other model");

  assert.equal(composed.route.provider, "other");
  assert.equal(composed.route.model, "model-b");
  assert.equal(adapter.requests.at(-1)?.provider, "other");
  assert.equal(adapter.requests.at(-1)?.model, "model-b");
  assert.equal(adapter.requests.at(-1)?.baseUrl, "https://example.test");
  assert.ok(adapter.requests.at(-1)?.messages.some((message) =>
    message.role === "user" && message.content === "remember this before switching"),
  );
  assert.equal(usage.at(-1)?.contextWindow, 20_000);

  await composed.session.close({ timeoutMs: 1_000 });
  await composed.close();
});

test("shared runtime prepares deferred tools, persists search and restores only current definitions", async (t) => {
  const { root, controller } = await fixture(t);
  const registry = new ToolRegistry([]);
  let prepared = false;
  let executions = 0;
  const definitions: ToolAdapterDefinition[] = Array.from({ length: 20 }, (_, index) => ({
    spec: {
      name: `remote_${index}`,
      description: `remote_${index}`,
      parameters: { type: "object" },
      promptGuidelines: [],
      catalog: { source: "mcp:fixture", originalName: `remote_${index}`, binding: "stable", exposure: "deferred" },
    },
    execute: () => { executions++; return { ok: true, content: "executed" }; },
  }));
  const requests: ModelRequest[] = [];
  const usage: Array<number | null> = [];
  const adapter: ModelAdapter = {
    name: "dynamic-fixture",
    runAttempt: async (request) => {
      assert.equal(prepared, true);
      requests.push(request);
      const name = requests.length === 1 ? "tool_search" : requests.length === 2 ? "remote_0" : undefined;
      return {
        requestId: request.requestId,
        finishReason: name ? "tool-calls" : "stop",
        usage: { inputTokens: 10, outputTokens: 2 },
        message: {
          role: "assistant", provider: request.provider, model: request.model,
          content: name
            ? [{ type: "tool-call", call: { id: request.requestId!, name, arguments: name === "tool_search" ? '{"query":"remote_0","limit":1}' : "{}" } }]
            : [{ type: "text", text: "done" }],
        },
      };
    },
  };
  const composed = createSessionRuntime({
    modelAdapter: adapter,
    catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: registry,
    prepareTools: async () => {
      if (!prepared) { registry.replaceOwner("mcp:fixture", definitions); prepared = true; }
    },
    sessionController: controller,
    projectRoot: root,
    startupCwd: root,
    version: "9.8.7",
    presentation: { contextUsageChanged: (value) => usage.push(value.contextTokens) },
  });
  try {
    assert.equal(await composed.agent.run("use remote_0"), "done");
    assert.deepEqual(requests.map((request) => request.tools.map((tool) => tool.name)), [
      ["tool_search"], ["remote_0", "tool_search"], ["remote_0", "tool_search"],
    ]);
    assert.equal(executions, 1);
    assert.equal(usage.at(-1), 12);
    assert.ok(usage.some((value) => value !== null && value > 12), "tool results temporarily extend measured usage");
    assert.equal(controller.history?.entries().filter((entry) => entry.entryType === "tool_catalog").length, 1);
    assert.equal(controller.history?.entries().filter((entry) => entry.entryType === "tool_definitions").length, 1);

    const sessionId = controller.currentSessionId!;
    await controller.createNew();
    composed.refreshSession();
    await controller.resume(sessionId);
    composed.refreshSession();
    await composed.agent.run("continue after resume");
    assert.ok(requests.at(-1)?.tools.some((tool) => tool.name === "remote_0"));

    registry.replaceOwner("mcp:fixture", definitions.map((definition) => ({
      ...definition, spec: { ...definition.spec, description: `${definition.spec.description} updated` },
    })));
    await composed.agent.run("check updated catalog");
    assert.deepEqual(requests.at(-1)?.tools.map((tool) => tool.name), ["tool_search"]);
  } finally {
    await composed.session.close({ timeoutMs: 1_000 });
    await composed.close();
  }
});

test("automatic compaction publishes unknown before the next main request", async (t) => {
  const { root, controller, adapter } = await fixture(t);
  const usage: Array<number | null> = [];
  const composed = createSessionRuntime({
    modelAdapter: adapter, catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([]), sessionController: controller,
    projectRoot: root, startupCwd: root, version: "9.8.7",
    presentation: { contextUsageChanged: (value) => usage.push(value.contextTokens) },
  });
  try {
    await composed.agent.run("x".repeat(20_000));
    await composed.agent.run("y".repeat(20_000));
    assert.ok(controller.history!.entries().some((entry) => entry.entryType === "compaction"));
    assert.ok(usage.includes(null));
    assert.equal(usage.at(-1), 18);
    const history = controller.history!;
    const entries = history.entries.bind(history);
    history.entries = () => { throw new Error("display refresh must not scan history"); };
    composed.refreshContextUsage();
    assert.equal(usage.at(-1), 18);
    history.entries = entries;
  } finally {
    await composed.session.close({ timeoutMs: 1_000 });
    await composed.close();
  }
});

test("provider overflow compacts history and retries the main request once", async (t) => {
  const { root, controller } = await fixture(t);
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = {
    name: "overflow-fixture",
    async runAttempt(request) {
      requests.push(request);
      request.onRequestOpened?.();
      const mainRequests = requests.filter((candidate) => candidate.reasoningEffort !== "off");
      if (request.reasoningEffort !== "off" && mainRequests.length === 3) {
        throw new ModelError("maximum context length exceeded", { kind: "context_overflow", hadDelta: false });
      }
      return {
        requestId: request.requestId ?? "",
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 2 },
        message: {
          role: "assistant", provider: request.provider, model: request.model,
          content: [{ type: "text", text: request.reasoningEffort === "off" ? "Earlier work summary." : "done" }],
        },
      };
    },
  };
  const composed = createSessionRuntime({
    modelAdapter: adapter, catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([]), sessionController: controller,
    projectRoot: root, startupCwd: root, version: "9.8.7",
  });
  try {
    await composed.agent.run("A".repeat(7_000));
    await composed.agent.run("B".repeat(7_000));
    assert.equal(await composed.agent.run("current question"), "done");

    const mainRequests = requests.filter((request) => request.reasoningEffort !== "off");
    const summaries = requests.filter((request) => request.reasoningEffort === "off");
    assert.equal(mainRequests.length, 4);
    assert.equal(summaries.length, 1);
    assert.notEqual(mainRequests[2]?.requestId, mainRequests[3]?.requestId);
    assert.ok(mainRequests[3]?.messages.some((message) => message.role === "user" &&
      message.content === "<conversation_summary>\nEarlier work summary.\n</conversation_summary>"));
    assert.ok(mainRequests[3]?.messages.some((message) => message.role === "user" && message.content === "current question"));
    assert.ok(!mainRequests[3]?.messages.some((message) => message.role === "user" && message.content === "A".repeat(7_000)));
    const compactions = controller.history!.entries().filter((entry) => entry.entryType === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0]?.payload.trigger, "provider_overflow");
  } finally {
    await composed.session.close({ timeoutMs: 1_000 });
    await composed.close();
  }
});
