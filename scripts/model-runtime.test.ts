import assert from "node:assert/strict";
import { test } from "node:test";

import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import {
  ModelError,
  ModelRuntime,
  ModelStreamCancelled,
  type ModelAdapter,
  type ModelProviderInfo,
  type ModelInfo,
  type ModelRequest,
  type ModelResult,
} from "@laohuang/llm";

class StubAdapter implements ModelAdapter {
  readonly name = "stub";
  requests: ModelRequest[] = [];
  private readonly completeFn: (
    request: ModelRequest,
  ) => Promise<ModelResult>;

  constructor(completeFn: (request: ModelRequest) => Promise<ModelResult>) {
    this.completeFn = completeFn;
  }

  runAttempt(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    return this.completeFn(request);
  }

  listProviders(): readonly ModelProviderInfo[] {
    return [{ id: "deepseek", name: "DeepSeek" }];
  }

  listModels(provider: string): readonly ModelInfo[] {
    return [{ provider, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }];
  }
}

function result(): ModelResult {
  return {
    requestId: "request-1",
    finishReason: "tool-calls",
    usage: { inputTokens: 8, outputTokens: 4, reasoningTokens: 2 },
    message: {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      content: [
        { type: "text", text: "final answer" },
        { type: "reasoning", text: "considering tools" },
        {
          type: "tool-call",
          call: { id: "call-1", name: "read", arguments: "{\"path\":\"answer.txt\"}" },
        },
      ],
    },
  };
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "hello" }],
    tools: [{
      name: "read",
      description: "Read file",
      parameters: { type: "object" },
      promptGuidelines: [],
    }],
    toolChoice: "auto",
    requestId: "request-1",
    ...overrides,
  };
}

test("forwards typed streamed content, reasoning, and tool-call deltas", async () => {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const adapter = new StubAdapter(async (modelRequest) => {
    modelRequest.onEvent?.({ type: "text-delta", text: "final " });
    modelRequest.onEvent?.({ type: "reasoning-delta", text: "considering " });
    modelRequest.onEvent?.({
      type: "tool-call-delta",
      index: 0,
      id: "call-1",
      name: "read",
      argumentsDelta: "{\"path\":",
    });
    modelRequest.onEvent?.({ type: "response-validating" });
    return result();
  });
  const runtime = new ModelRuntime(adapter);

  const completion = await runtime.complete({
    ...request(),
    onDelta: (kind, payload) => events.push({ kind, payload }),
  });

  assert.deepEqual(events, [
    { kind: "model_text_delta", payload: { text: "final " } },
    { kind: "model_reasoning_delta", payload: { text: "considering " } },
    {
      kind: "model_tool_call_delta",
      payload: {
        index: 0,
        id: "call-1",
        name: "read",
        arguments: "{\"path\":",
      },
    },
    { kind: "model_response_validating", payload: {} },
  ]);
  assert.deepEqual(completion, result());
});

test("does not invoke the adapter after model cancellation", async () => {
  const token = new CancelToken();
  token.cancel("user stopped");
  const adapter = new StubAdapter(async () => result());
  const runtime = new ModelRuntime(adapter);

  await assert.rejects(
    runtime.complete({ ...request(), cancelToken: token }),
    (error: unknown) => {
      assert.ok(error instanceof ModelStreamCancelled);
      assert.equal((error as Error).message, "user stopped");
      return true;
    },
  );
  assert.equal(adapter.requests.length, 0);
});

test("normalizes adapter failures with the model error taxonomy", async () => {
  const rateLimited = Object.assign(new Error("slow down"), { status: 429 });
  const adapter = new StubAdapter(async () => {
    throw rateLimited;
  });
  const runtime = new ModelRuntime(adapter);

  await assert.rejects(runtime.complete(request()), (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.message, "slow down");
    return true;
  });
});
