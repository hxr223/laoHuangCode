import assert from "node:assert/strict";
import { test } from "node:test";

import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import {
  ModelError,
  ModelRuntime,
  ModelStreamCancelled,
  type ModelAdapter,
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

test("forwards reasoning effort to the adapter request", async () => {
  const adapter = new StubAdapter(async () => result());
  const runtime = new ModelRuntime(adapter);

  await runtime.complete({
    ...request(),
    reasoningEffort: "low",
  });

  assert.equal(adapter.requests[0]?.reasoningEffort, "low");
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

test("retries transient pre-delta failures with deterministic delays", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const adapter = new StubAdapter(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new ModelError("overloaded", { kind: "server" });
    }
    return result();
  });
  const runtime = new ModelRuntime(adapter, {
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  await runtime.complete({
    ...request(),
    onDelta: (kind, payload) => events.push({ kind, payload }),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [250, 1000]);
  assert.deepEqual(events, [
    {
      kind: "model_retry_scheduled",
      payload: { attempt: 2, max_attempts: 3, delay_ms: 250, error_kind: "server" },
    },
    {
      kind: "model_retry_scheduled",
      payload: { attempt: 3, max_attempts: 3, delay_ms: 1000, error_kind: "server" },
    },
  ]);
});

test("does not retry protocol, authentication, or post-delta failures", async () => {
  for (const error of [
    new ModelError("bad route", { kind: "protocol" }),
    new ModelError("bad key", { kind: "authentication" }),
    new ModelError("partial", { kind: "server", hadDelta: true }),
  ]) {
    const adapter = new StubAdapter(async () => {
      throw error;
    });
    const runtime = new ModelRuntime(adapter, { sleep: async () => {} });
    await assert.rejects(runtime.complete(request()), error);
    assert.equal(adapter.requests.length, 1);
  }
});

test("maxAttempts one disables retries and forwards timeoutMs", async () => {
  const adapter = new StubAdapter(async () => {
    throw new ModelError("timed out", { kind: "timeout" });
  });
  const runtime = new ModelRuntime(adapter, { sleep: async () => {} });

  await assert.rejects(
    runtime.complete({ ...request(), timeoutMs: 3000, maxAttempts: 1 }),
    (error: unknown) => error instanceof ModelError && error.kind === "timeout",
  );
  assert.equal(adapter.requests.length, 1);
  assert.equal(adapter.requests[0]?.timeoutMs, 3000);
});

test("cancellation during retry delay prevents the next attempt", async () => {
  const token = new CancelToken();
  const adapter = new StubAdapter(async () => {
    throw new ModelError("overloaded", { kind: "server" });
  });
  const runtime = new ModelRuntime(adapter, {
    sleep: async (_delayMs, cancelToken) => {
      cancelToken?.cancel("cancelled during retry delay");
      if (cancelToken?.isCancelled()) {
        throw new ModelStreamCancelled(cancelToken.reason);
      }
    },
  });

  await assert.rejects(
    runtime.complete({ ...request(), cancelToken: token }),
    ModelStreamCancelled,
  );
  assert.equal(adapter.requests.length, 1);
});
