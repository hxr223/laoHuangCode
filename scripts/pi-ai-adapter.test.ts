import test from "node:test";
import assert from "node:assert/strict";

import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import {
  ModelError,
  ModelStreamCancelled,
  type ModelRequest,
} from "@laohuang/llm";
import { PiAiAdapter } from "../packages/llm/llm-pi-ai/src/index.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
  Provider,
} from "@earendil-works/pi-ai";

test("PiAiAdapter rejects unknown providers and models before streaming", async () => {
  const fake = new FakeModels();
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await assert.rejects(
    adapter.runAttempt(request({ provider: "openai" })),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  await assert.rejects(
    adapter.runAttempt(request({ model: "missing" })),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  assert.equal(fake.streams.length, 0);
});

test("PiAiAdapter passes baseUrl, timeout, temperature, and cancel signal", async () => {
  const token = new CancelToken();
  const fake = new FakeModels();
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await adapter.runAttempt(request({
    baseUrl: "https://api.deepseek.example",
    temperature: 0.2,
    timeoutMs: 3000,
    cancelToken: token,
  }));

  assert.equal(fake.streams.length, 1);
  assert.equal(fake.streams[0]?.model.baseUrl, "https://api.deepseek.example");
  assert.equal(fake.baseModel.baseUrl, "https://api.deepseek.com");
  assert.equal("apiKey" in fake.streams[0]!.options, false);
  assert.equal(fake.streams[0]?.options.temperature, 0.2);
  assert.equal(fake.streams[0]?.options.timeoutMs, 3000);
  assert.equal(fake.streams[0]?.options.signal, token.signal);
  assert.equal(fake.streams[0]?.options.maxRetries, 0);
});

test("PiAiAdapter passes the requested thinking level for reasoning-capable models", async () => {
  const fake = new FakeModels();
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await adapter.runAttempt(request({ reasoningEffort: "low" }));

  assert.equal(fake.streams[0]?.options.reasoning, "low");
});

test("PiAiAdapter omits thinking when requested effort is off", async () => {
  const fake = new FakeModels();
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await adapter.runAttempt(request({ reasoningEffort: "off" }));

  assert.equal(fake.streams[0]?.options.reasoning, undefined);
});

test("PiAiAdapter clamps unsupported thinking levels for the concrete model", async () => {
  const fake = new FakeModels();
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await adapter.runAttempt(request({ reasoningEffort: "max" }));

  assert.equal(fake.streams[0]?.options.reasoning, "high");
});

test("PiAiAdapter honors cancellation preflight and request-open abort", async () => {
  const token = new CancelToken();
  token.cancel("stop");
  const fake = new FakeModels();
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await assert.rejects(
    adapter.runAttempt(request({ cancelToken: token })),
    ModelStreamCancelled,
  );
  await assert.rejects(
    adapter.runAttempt(request({ onRequestOpened: () => false })),
    ModelStreamCancelled,
  );
  assert.equal(fake.streams.length, 0);
});

test("PiAiAdapter rejects DSML protocol leakage without dispatching tools", async () => {
  const dsml = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"bash\">" +
    "<｜｜DSML｜｜parameter name=\"command\">pwd</｜｜DSML｜｜parameter>" +
    "</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>";
  const fake = new FakeModels(doneWithText(dsml));
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  await assert.rejects(
    adapter.runAttempt(request()),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  assert.equal(fake.streams.length, 1);
});

test("PiAiAdapter keeps ordinary DSML prose as text", async () => {
  const fake = new FakeModels(doneWithText("The string DSML is documented here."));
  const adapter = new PiAiAdapter(
    { eligibleProviderIds: new Set(["deepseek"]) },
    fake,
  );

  const result = await adapter.runAttempt(request());
  assert.deepEqual(result.message.content, [
    { type: "text", text: "The string DSML is documented here." },
  ]);
});

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    requestId: "request-1",
    ...overrides,
  };
}

function doneWithText(text: string): readonly AssistantMessageEvent[] {
  return [{
    type: "done",
    reason: "stop",
    message: assistant([{ type: "text", text }]),
  }];
}

class FakeModels implements Pick<Models, "getProviders" | "getProvider" | "getModels" | "getModel" | "streamSimple"> {
  readonly baseModel: Model<"openai-completions"> = {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  readonly streams: Array<{
    model: Model<"openai-completions">;
    context: Context;
    options: ModelsSimpleStreamOptions;
  }> = [];
  private readonly queued: readonly AssistantMessageEvent[];

  constructor(queued: readonly AssistantMessageEvent[] = doneWithText("ok")) {
    this.queued = queued;
  }

  getProviders(): readonly Provider[] {
    return [
      {
        id: "deepseek",
        name: "DeepSeek",
        auth: { apiKey: { resolve: async () => undefined } },
        getModels: () => [this.baseModel],
        stream: () => this.streamSimple(this.baseModel, { messages: [] }),
        streamSimple: (model, context, options) =>
          this.streamSimple(model, context, options),
      },
      {
        id: "openai",
        name: "OpenAI",
        auth: { apiKey: { resolve: async () => undefined } },
        getModels: () => [],
        stream: () => this.streamSimple(this.baseModel, { messages: [] }),
        streamSimple: (model, context, options) =>
          this.streamSimple(model, context, options),
      },
    ];
  }

  getProvider(id: string): Provider | undefined {
    return this.getProviders().find((provider) => provider.id === id);
  }

  getModels(provider?: string): readonly Model<"openai-completions">[] {
    return provider === "deepseek" || provider === undefined ? [this.baseModel] : [];
  }

  getModel(provider: string, id: string): Model<"openai-completions"> | undefined {
    return provider === "deepseek" && id === this.baseModel.id
      ? this.baseModel
      : undefined;
  }

  streamSimple(
    model: Model<"openai-completions">,
    context: Context,
    options: ModelsSimpleStreamOptions = {},
  ): AsyncGenerator<AssistantMessageEvent> {
    this.streams.push({ model, context, options });
    return events(this.queued);
  }
}

async function* events(
  items: readonly AssistantMessageEvent[],
): AsyncGenerator<AssistantMessageEvent> {
  yield* items;
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}
