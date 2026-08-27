import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SmallModelSemanticClassifier,
} from "../apps/cli/src/semantic-classifier.ts";
import type { ModelResult, ModelRuntimeRequest } from "@laohuang/llm";

interface CapturedCall {
  request: ModelRuntimeRequest;
}

function fakeRuntime(body: unknown): {
  modelRuntime: { complete(request: ModelRuntimeRequest): Promise<ModelResult> };
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const modelRuntime = {
    async complete(request: ModelRuntimeRequest): Promise<ModelResult> {
      calls.push({ request });
      return {
        requestId: "router-request",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        message: {
          role: "assistant",
          provider: request.provider,
          model: request.model,
          content: [{ type: "text", text: JSON.stringify(body) }],
        },
      };
    },
  };
  return { modelRuntime, calls };
}

function fakeFailingRuntime(): {
  modelRuntime: { complete(request: ModelRuntimeRequest): Promise<ModelResult> };
} {
  return {
    modelRuntime: {
      async complete(): Promise<ModelResult> {
        throw new Error("timeout");
      },
    },
  };
}

test("uses one no-history request and accepts confident json", async () => {
  const { modelRuntime, calls } = fakeRuntime({
    strategy: "steer",
    confidence: 0.91,
  });
  const classifier = new SmallModelSemanticClassifier({
    modelRuntime,
    route: { provider: "deepseek", model: "router-model", baseUrl: null },
  });
  const active = { taskId: "task-1", state: "running_model" };
  const event = { payload: { content: "改成另一种实现" } };

  const decision = await classifier.classify(event, active);

  assert.ok(decision);
  assert.equal(decision.strategy, "steer");
  assert.equal(calls.length, 1);
  const request = calls[0]!.request;
  assert.equal(request.provider, "deepseek");
  assert.equal(request.model, "router-model");
  assert.ok(!("toolChoice" in request));
  assert.equal(request.tools.length, 0);
  assert.equal(request.temperature, 0);
  assert.equal(request.timeoutMs, 3000);
  assert.equal(request.maxAttempts, 1);
  assert.equal(request.reasoningEffort, "off");
  const messages = request.messages;
  assert.equal(messages.length, 2);
});

test("low confidence or invalid output falls back", async () => {
  const { modelRuntime } = fakeRuntime({ strategy: "follow_up", confidence: 0.2 });
  const classifier = new SmallModelSemanticClassifier({
    modelRuntime,
    route: { provider: "deepseek", model: "router-model", baseUrl: null },
  });
  const active = { taskId: "task-1", state: "running_model" };
  const event = { payload: { content: "还有一个想法" } };

  assert.equal(await classifier.classify(event, active), null);
});

test("runtime failures fall back without routing", async () => {
  const { modelRuntime } = fakeFailingRuntime();
  const classifier = new SmallModelSemanticClassifier({
    modelRuntime,
    route: { provider: "deepseek", model: "router-model", baseUrl: null },
  });

  assert.equal(
    await classifier.classify(
      { payload: { content: "还有一个想法" } },
      { taskId: "task-1", state: "running_model" },
    ),
    null,
  );
});
