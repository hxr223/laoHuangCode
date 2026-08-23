import assert from "node:assert/strict";
import { test } from "node:test";

import { CancelToken } from "../src/cancellation.ts";
import {
  ModelError,
  type ChatClientLike,
  type ModelAdapter,
  type ModelRequest,
} from "../src/model-adapter.ts";
import {
  ModelStreamCancelled,
  StreamResult,
} from "../src/model-stream.ts";
import { ModelRuntime } from "../src/runtime/model-runtime.ts";

class StubAdapter implements ModelAdapter {
  readonly name = "stub";
  readonly capabilities = {
    streaming: true,
    reasoningReplay: false,
    thinkingSettings: false,
  };
  requests: ModelRequest[] = [];
  private readonly completeFn: (
    request: ModelRequest,
  ) => Promise<StreamResult>;

  constructor(completeFn: (request: ModelRequest) => Promise<StreamResult>) {
    this.completeFn = completeFn;
  }

  complete(_client: ChatClientLike, request: ModelRequest): Promise<StreamResult> {
    this.requests.push(request);
    return this.completeFn(request);
  }
}

function result(): StreamResult {
  return new StreamResult({
    requestId: "request-1",
    content: "final answer",
    reasoningContent: "considering tools",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read", arguments: '{"path":"answer.txt"}' },
      },
    ],
    finishReason: "tool_calls",
    usage: { total_tokens: 12 },
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    client: { chat: { completions: undefined as never } },
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "read" } }],
    toolChoice: "auto",
    requestId: "request-1",
    ...overrides,
  };
}

test("forwards streamed content, reasoning, and tool-call deltas", async () => {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const adapter = new StubAdapter(async (modelRequest) => {
    modelRequest.onDelta?.("model_text_delta", { text: "final " });
    modelRequest.onDelta?.("model_reasoning_delta", { text: "considering " });
    modelRequest.onDelta?.("model_tool_call_delta", {
      id: "call-1",
      name: "read",
      arguments: '{"path":',
    });
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
      payload: { id: "call-1", name: "read", arguments: '{"path":' },
    },
  ]);
  assert.equal(completion.content, "final answer");
  assert.equal(completion.reasoningContent, "considering tools");
  assert.deepEqual(completion.toolCalls, [
    {
      id: "call-1",
      type: "function",
      function: { name: "read", arguments: '{"path":"answer.txt"}' },
    },
  ]);
  assert.equal(completion.finishReason, "tool_calls");
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
