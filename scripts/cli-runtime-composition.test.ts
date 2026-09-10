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
import { ToolRegistry } from "@laohuang/tools";

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
  const composed = createSessionRuntime({
    modelAdapter: adapter,
    catalog: new FakeCatalog(),
    route: { provider: "test", model: "model-a", baseUrl: null },
    tools: new ToolRegistry([]),
    sessionController: controller,
    projectRoot: root,
    startupCwd: root,
    version: "9.8.7",
  });

  await composed.session.submitInput("alpha");
  assert.equal(await composed.session.waitForIdle(), true);
  await composed.session.submitInput("beta");
  assert.equal(await composed.session.waitForIdle(), true);

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
    },
  });
  const originalSessionId = controller.currentSessionId!;

  await composed.agent.run("old turn to summarize");
  await composed.agent.run("x".repeat(10_000));
  await composed.agent.run("retain this tail");
  await composed.compact();
  assert.equal(controller.history?.entries().at(-1)?.entryType, "compaction");
  assert.ok(composed.agent.messages.some((message) =>
    message.role === "user" && message.content.includes("Earlier turns discussed alpha and beta.")),
  );

  await controller.createNew();
  composed.refreshSession();
  assert.deepEqual(composed.agent.messages.map((message) => message.role), ["system"]);

  await controller.resume(originalSessionId);
  composed.refreshSession();
  assert.ok(composed.agent.messages.some((message) =>
    message.role === "user" && message.content.includes("Earlier turns discussed alpha and beta.")),
  );
  assert.ok(snapshots.some((snapshot) => snapshot.includes("compaction")));

  await composed.session.close({ timeoutMs: 1_000 });
  await composed.close();
});

test("switchModel updates all model and context routes", async (t) => {
  const { root, controller, adapter } = await fixture(t);
  const usage: Array<{ contextTokens: number; contextWindow: number }> = [];
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
