import test from "node:test";
import assert from "node:assert/strict";

import {
  ModelError,
  ModelStreamCancelled,
  type ModelEvent,
  type ModelRequest,
} from "@laohuang/llm";
import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import { consumePiEvents } from "../packages/llm/llm-pi-ai/src/index.ts";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
} from "@earendil-works/pi-ai";

test("consumePiEvents converts reasoning and tool call streams", async () => {
  const emitted: ModelEvent[] = [];
  const result = await consumePiEvents(
    events([
      { type: "start", partial: assistant([]) },
      { type: "thinking_delta", contentIndex: 0, delta: "inspect", partial: assistant([]) },
      {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: "{\"path\":\"a.txt\"}",
        partial: assistant([]),
      },
      {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: toolCall("call-1", "read", { path: "a.txt" }),
        partial: assistant([]),
      },
      {
        type: "done",
        reason: "toolUse",
        message: assistant([
          { type: "thinking", thinking: "inspect" },
          toolCall("call-1", "read", { path: "a.txt" }),
        ], { stopReason: "toolUse" }),
      },
    ]),
    request(),
    (event) => emitted.push(event),
  );

  assert.equal(result.finishReason, "tool-calls");
  assert.deepEqual(result.message.content, [
    { type: "reasoning", text: "inspect" },
    {
      type: "tool-call",
      call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
    },
  ]);
  assert.deepEqual(emitted.map((event) => event.type), [
    "reasoning-delta",
    "tool-call-delta",
    "response-validating",
  ]);
});

test("consumePiEvents converts final text, usage, and stop finish", async () => {
  const result = await consumePiEvents(
    events([
      { type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant([]) },
      {
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: "hello" }]),
      },
    ]),
    request(),
  );

  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    reasoningTokens: 1,
  });
});

test("consumePiEvents preserves parallel tool calls in content order", async () => {
  const result = await consumePiEvents(
    events([
      {
        type: "done",
        reason: "toolUse",
        message: assistant([
          toolCall("call-1", "read", { path: "a.txt" }),
          toolCall("call-2", "bash", { command: "pwd" }),
        ], { stopReason: "toolUse" }),
      },
    ]),
    request(),
  );

  assert.deepEqual(result.message.content, [
    {
      type: "tool-call",
      call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
    },
    {
      type: "tool-call",
      call: { id: "call-2", name: "bash", arguments: "{\"command\":\"pwd\"}" },
    },
  ]);
});

test("consumePiEvents maps aborted and provider errors", async () => {
  await assert.rejects(
    consumePiEvents(
      events([{ type: "error", reason: "aborted", error: assistant([], { errorMessage: "user stopped" }) }]),
      request(),
    ),
    ModelStreamCancelled,
  );

  await assert.rejects(
    consumePiEvents(
      events([{ type: "error", reason: "error", error: assistant([], { errorMessage: "provider failed" }) }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "retryable",
  );
});

test("consumePiEvents rejects invalid terminal streams", async () => {
  await assert.rejects(
    consumePiEvents(events([]), request()),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  await assert.rejects(
    consumePiEvents(
      events([{ type: "done", reason: "toolUse", message: assistant([], { stopReason: "toolUse" }) }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  await assert.rejects(
    consumePiEvents(
      events([{
        type: "done",
        reason: "toolUse",
        message: assistant([{ type: "toolCall", id: "", name: "read", arguments: {} }], {
          stopReason: "toolUse",
        }),
      }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  await assert.rejects(
    consumePiEvents(
      events([{
        type: "done",
        reason: "toolUse",
        message: assistant([{
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: "bad" as unknown as Record<string, unknown>,
        }], { stopReason: "toolUse" }),
      }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
  await assert.rejects(
    consumePiEvents(
      events([{ type: "done", reason: "stop", message: assistant([]) }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
});

test("consumePiEvents rejects invalid usage counts", async () => {
  await assert.rejects(
    consumePiEvents(
      events([{
        type: "done",
        reason: "stop",
        message: assistant([{ type: "text", text: "hello" }], {
          usage: {
            ...assistant([]).usage,
            output: -1,
          },
        }),
      }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
});

test("consumePiEvents cancels and rejects stale streams after deltas", async () => {
  const token = new CancelToken();
  await assert.rejects(
    consumePiEvents(
      cancellingEvents(token),
      request({ cancelToken: token }),
    ),
    ModelStreamCancelled,
  );

  const activeChecks = [true, false][Symbol.iterator]();
  await assert.rejects(
    consumePiEvents(
      events([
        { type: "text_delta", contentIndex: 0, delta: "partial", partial: assistant([]) },
        {
          type: "done",
          reason: "stop",
          message: assistant([{ type: "text", text: "partial" }]),
        },
      ]),
      request({ isRequestActive: () => activeChecks.next().value === true }),
    ),
    ModelStreamCancelled,
  );
});

test("consumePiEvents rejects textual DSML envelopes but keeps ordinary DSML prose", async () => {
  const dsml = "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"bash\">" +
    "<｜｜DSML｜｜parameter name=\"command\">pwd</｜｜DSML｜｜parameter>" +
    "</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>";

  await assert.rejects(
    consumePiEvents(
      events([{ type: "done", reason: "stop", message: assistant([{ type: "text", text: dsml }]) }]),
      request(),
    ),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );

  const result = await consumePiEvents(
    events([{
      type: "done",
      reason: "stop",
      message: assistant([{ type: "text", text: "The string DSML is documented here." }]),
    }]),
    request(),
  );
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

async function* events(
  items: readonly AssistantMessageEvent[],
): AsyncGenerator<AssistantMessageEvent> {
  yield* items;
}

async function* cancellingEvents(
  token: CancelToken,
): AsyncGenerator<AssistantMessageEvent> {
  yield { type: "text_delta", contentIndex: 0, delta: "partial", partial: assistant([]) };
  token.cancel("stop now");
  yield {
    type: "done",
    reason: "stop",
    message: assistant([{ type: "text", text: "partial" }]),
  };
}

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}
