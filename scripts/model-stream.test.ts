import test from "node:test";
import assert from "node:assert/strict";

import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import {
  ChatCompletionStreamer,
} from "../packages/llm/llm-openai-compatible/src/model-stream.ts";
import {
  ModelStreamCancelled,
  ModelStreamError,
  StaleModelRequest,
  type DeltaCallback,
} from "@laohuang/llm";

// ---------------------------------------------------------------------------
// Fakes mirroring tests/test_model_stream.py
// ---------------------------------------------------------------------------

type DeltaSpec = {
  content?: string | null;
  reasoningContent?: string | null;
  toolCalls?: unknown[] | null;
};

function delta(spec: DeltaSpec = {}) {
  return {
    content: spec.content ?? null,
    reasoning_content: spec.reasoningContent ?? null,
    tool_calls: spec.toolCalls ?? null,
  };
}

type ChunkSpec = {
  delta?: unknown;
  finishReason?: string | null;
  usage?: unknown;
};

function chunk(spec: ChunkSpec = {}) {
  const deltaValue = spec.delta ?? null;
  const finishReason = spec.finishReason ?? null;
  const choices: unknown[] = [];
  if (deltaValue !== null || finishReason !== null) {
    choices.push({ delta: deltaValue, finish_reason: finishReason });
  }
  return { choices, usage: spec.usage ?? null };
}

type ToolFragmentSpec = {
  callId?: string | null;
  name?: string | null;
  arguments?: string | null;
  callType?: string | null;
};

function toolFragment(index: number, spec: ToolFragmentSpec = {}) {
  return {
    index,
    id: spec.callId ?? null,
    type: spec.callType ?? null,
    function: {
      name: spec.name ?? null,
      arguments: spec.arguments ?? null,
    },
  };
}

class FakeStream {
  closed = false;
  private readonly chunks: Iterable<unknown>;

  constructor(chunks: Iterable<unknown>) {
    this.chunks = chunks;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for (const chunkValue of this.chunks) {
      yield chunkValue;
    }
  }

  close(): void {
    this.closed = true;
  }
}

class RaisingStream {
  closed = false;
  private readonly firstChunk: unknown;
  private readonly error: Error;

  constructor(options: { firstChunk?: unknown; error?: Error } = {}) {
    this.firstChunk = options.firstChunk ?? null;
    this.error = options.error ?? new Error("stream disconnected");
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    if (this.firstChunk !== null) {
      yield this.firstChunk;
    }
    throw this.error;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeCompletions {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly responses: Iterator<unknown>;

  constructor(...responses: unknown[]) {
    this.responses = responses[Symbol.iterator]();
  }

  create(request: Record<string, unknown>): unknown {
    this.requests.push(request);
    const response = this.responses.next().value;
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

function recordEvents(events: Array<[string, Record<string, unknown>]>): DeltaCallback {
  return (kind, payload) => {
    events.push([kind, payload]);
  };
}

// ---------------------------------------------------------------------------
// Streamer behaviour (mirrors the ModelStreamTests streamer cases)
// ---------------------------------------------------------------------------

test("non-stream response emits text and validation events", async () => {
  const response = {
    choices: [
      {
        message: {
          content: "complete answer",
          reasoning_content: null,
          tool_calls: [],
        },
        finish_reason: "stop",
      },
    ],
    usage: null,
  };
  const events: Array<[string, Record<string, unknown>]> = [];

  const result = await new ChatCompletionStreamer(
    new FakeCompletions(response),
  ).complete({
    model: "model",
    messages: [],
    tools: [],
    onDelta: recordEvents(events),
  });

  assert.equal(result.content, "complete answer");
  assert.deepEqual(
    events.map(([kind]) => kind),
    ["model_text_delta", "model_response_validating"],
  );
  assert.equal(events[0]?.[1]["text"], "complete answer");
});

test("text deltas are coalesced before publication", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const stream = new FakeStream([
    chunk({ delta: delta({ content: "a" }) }),
    chunk({ delta: delta({ content: "b" }) }),
    chunk({ delta: delta({ content: "c" }) }),
    chunk({ delta: delta(), finishReason: "stop" }),
  ]);

  const result = await new ChatCompletionStreamer(
    new FakeCompletions(stream),
  ).complete({
    model: "model",
    messages: [],
    tools: [],
    onDelta: recordEvents(events),
  });

  const textEvents = events.filter(([kind]) => kind === "model_text_delta");
  assert.equal(result.content, "abc");
  assert.equal(textEvents.length, 1);
  assert.equal(textEvents[0]?.[1]["text"], "abc");
});

test("assembles reasoning content, tool calls and usage", async () => {
  const events: Array<[string, Record<string, unknown>]> = [];
  const stream = new FakeStream([
    chunk({ delta: delta({ reasoningContent: "think " }) }),
    chunk({
      delta: delta({
        toolCalls: [
          toolFragment(0, {
            callId: "call_",
            name: "re",
            arguments: '{"pa',
            callType: "function",
          }),
        ],
      }),
    }),
    chunk({
      delta: delta({
        toolCalls: [
          toolFragment(0, {
            callId: "1",
            name: "ad",
            arguments: 'th":"README.md"}',
          }),
        ],
      }),
    }),
    chunk({ delta: delta(), finishReason: "tool_calls" }),
    chunk({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  ]);
  const completions = new FakeCompletions(stream);

  const result = await new ChatCompletionStreamer(completions).complete({
    model: "deepseek-reasoner",
    messages: [],
    tools: [],
    toolChoice: "none",
    onDelta: recordEvents(events),
  });

  assert.equal(result.reasoningContent, "think ");
  assert.equal(result.toolCalls[0]?.id, "call_1");
  assert.equal(result.toolCalls[0]?.function.name, "read");
  assert.equal(
    result.toolCalls[0]?.function.arguments,
    '{"path":"README.md"}',
  );
  assert.equal(
    (result.usage as Record<string, unknown>)["completion_tokens"],
    3,
  );
  assert.equal(completions.requests[0]?.["stream"], true);
  assert.deepEqual(completions.requests[0]?.["stream_options"], {
    include_usage: true,
  });
  assert.equal(completions.requests[0]?.["tool_choice"], "none");
  assert.ok(events.some(([kind]) => kind === "model_reasoning_delta"));
  assert.ok(events.some(([kind]) => kind === "model_tool_call_delta"));
});

test("retries once when the stream fails before the first delta", async () => {
  const first = new RaisingStream();
  const second = new FakeStream([
    chunk({ delta: delta({ content: "done" }) }),
    chunk({ delta: delta(), finishReason: "stop" }),
  ]);
  const completions = new FakeCompletions(first, second);

  const result = await new ChatCompletionStreamer(completions).complete({
    model: "model",
    messages: [],
    tools: [],
  });

  assert.equal(result.content, "done");
  assert.equal(completions.requests.length, 2);
  assert.equal(first.closed, true);
});

test("does not silently retry after a delta", async () => {
  const first = new RaisingStream({
    firstChunk: chunk({ delta: delta({ content: "partial" }) }),
  });
  const completions = new FakeCompletions(first);

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelStreamError);
      assert.match(error.message, /disconnected/);
      assert.equal(error.hadDelta, true);
      return true;
    },
  );
  assert.equal(completions.requests.length, 1);
  assert.equal(first.closed, true);
});

test("rejects truncated responses", async () => {
  const completions = new FakeCompletions(
    new FakeStream([
      chunk({ delta: delta({ content: "partial" }) }),
      chunk({ delta: delta(), finishReason: "length" }),
    ]),
  );

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelStreamError);
      assert.match(error.message, /finish_reason=length/);
      assert.equal(error.hadDelta, true);
      return true;
    },
  );
});

test("cancel and stale request abort the stream", async () => {
  const token = new CancelToken();

  function* cancellingChunks(): Generator<unknown> {
    yield chunk({ delta: delta({ content: "partial" }) });
    token.cancel("stop now");
    yield chunk({ delta: delta({ content: "ignored" }) });
  }

  const stream = new FakeStream(cancellingChunks());
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(new FakeCompletions(stream)).complete({
        model: "model",
        messages: [],
        tools: [],
        cancelToken: token,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelStreamCancelled);
      assert.match(error.message, /stop now/);
      return true;
    },
  );
  assert.equal(stream.closed, true);

  const activeChecks = [true, false][Symbol.iterator]();
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(
        new FakeCompletions(
          new FakeStream([chunk({ delta: delta({ content: "stale" }) })]),
        ),
      ).complete({
        model: "model",
        messages: [],
        tools: [],
        requestId: "old-request",
        isRequestActive: () => activeChecks.next().value === true,
      }),
    StaleModelRequest,
  );
});

// ---------------------------------------------------------------------------
// Validation and assembly rules (Python ModelAttempt/ToolCallAccumulator
// semantics exercised directly through the streamer)
// ---------------------------------------------------------------------------

test("rejects a stream that ends without a finish reason", async () => {
  const completions = new FakeCompletions(
    new FakeStream([chunk({ delta: delta({ content: "partial" }) })]),
  );

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /without a finish reason/,
  );
});

test("rejects conflicting finish reasons", async () => {
  const completions = new FakeCompletions(
    new FakeStream([
      chunk({ delta: delta({ content: "a" }), finishReason: "stop" }),
      chunk({ delta: delta({ content: "b" }), finishReason: "tool_calls" }),
    ]),
  );

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /conflicting finish reasons/,
  );
});

test("rejects finish_reason=tool_calls without any tool call", async () => {
  const completions = new FakeCompletions(
    new FakeStream([chunk({ delta: delta(), finishReason: "tool_calls" })]),
  );

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /no tool calls/,
  );
});

test("rejects tool calls paired with finish_reason=stop", async () => {
  const completions = new FakeCompletions(
    new FakeStream([
      chunk({
        delta: delta({
          toolCalls: [
            toolFragment(0, {
              callId: "call_1",
              name: "read",
              arguments: "{}",
              callType: "function",
            }),
          ],
        }),
        finishReason: "stop",
      }),
    ]),
  );

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /finish_reason=stop/,
  );
});

test("rejects invalid JSON tool arguments and non-object arguments", async () => {
  const invalidJson = new FakeCompletions(
    new FakeStream([
      chunk({
        delta: delta({
          toolCalls: [
            toolFragment(0, {
              callId: "call_1",
              name: "read",
              arguments: "{not json",
              callType: "function",
            }),
          ],
        }),
        finishReason: "tool_calls",
      }),
    ]),
  );
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(invalidJson).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /Invalid JSON arguments for tool read/,
  );

  const nonObject = new FakeCompletions(
    new FakeStream([
      chunk({
        delta: delta({
          toolCalls: [
            toolFragment(0, {
              callId: "call_1",
              name: "read",
              arguments: "[1]",
              callType: "function",
            }),
          ],
        }),
        finishReason: "tool_calls",
      }),
    ]),
  );
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(nonObject).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /must be a JSON object/,
  );
});

test("rejects tool calls without id, name, or with an unsupported type", async () => {
  const noId = new FakeCompletions(
    new FakeStream([
      chunk({
        delta: delta({
          toolCalls: [
            toolFragment(0, { name: "read", arguments: "{}" }),
          ],
        }),
        finishReason: "tool_calls",
      }),
    ]),
  );
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(noId).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /index 0 has no id/,
  );

  const badType = new FakeCompletions(
    new FakeStream([
      chunk({
        delta: delta({
          toolCalls: [
            toolFragment(0, {
              callId: "call_1",
              name: "read",
              arguments: "{}",
              callType: "custom",
            }),
          ],
        }),
        finishReason: "tool_calls",
      }),
    ]),
  );
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(badType).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /Unsupported tool call type at index 0: custom/,
  );

  const noName = new FakeCompletions(
    new FakeStream([
      chunk({
        delta: delta({
          toolCalls: [
            toolFragment(0, {
              callId: "call_1",
              arguments: "{}",
              callType: "function",
            }),
          ],
        }),
        finishReason: "tool_calls",
      }),
    ]),
  );
  await assert.rejects(
    () =>
      new ChatCompletionStreamer(noName).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /index 0 has no function name/,
  );
});

test("rejects an empty assistant turn", async () => {
  const completions = new FakeCompletions(
    new FakeStream([chunk({ delta: delta(), finishReason: "stop" })]),
  );

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /neither text nor tool calls/,
  );
});

test("rejects a non-iterable stream object", async () => {
  const completions = new FakeCompletions({ not: "a stream" });

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(completions).complete({
        model: "model",
        messages: [],
        tools: [],
      }),
    /non-iterable stream/,
  );
});

test("cancelled before request acknowledgement closes the stream", async () => {
  const stream = new FakeStream([
    chunk({ delta: delta({ content: "unseen" }) }),
    chunk({ delta: delta(), finishReason: "stop" }),
  ]);

  await assert.rejects(
    () =>
      new ChatCompletionStreamer(new FakeCompletions(stream)).complete({
        model: "model",
        messages: [],
        tools: [],
        onRequestOpened: () => false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ModelStreamCancelled);
      assert.match(error.message, /acknowledgement/);
      return true;
    },
  );
  assert.equal(stream.closed, true);
});

test("non-stream tool call response defaults the finish reason", async () => {
  const response = {
    choices: [
      {
        message: {
          content: null,
          reasoning_content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  };

  const result = await new ChatCompletionStreamer(
    new FakeCompletions(response),
  ).complete({ model: "model", messages: [], tools: [] });

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls[0]?.function.name, "read");
});

test("messageDict mirrors the assistant wire shape", async () => {
  const stream = new FakeStream([
    chunk({ delta: delta({ reasoningContent: "think" }) }),
    chunk({
      delta: delta({
        toolCalls: [
          toolFragment(0, {
            callId: "call_1",
            name: "read",
            arguments: "{}",
            callType: "function",
          }),
        ],
      }),
    }),
    chunk({ delta: delta(), finishReason: "tool_calls" }),
  ]);

  const result = await new ChatCompletionStreamer(
    new FakeCompletions(stream),
  ).complete({ model: "model", messages: [], tools: [] });

  assert.deepEqual(result.messageDict(), {
    role: "assistant",
    reasoning_content: "think",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{}" },
      },
    ],
  });

  const textOnly = new FakeStream([
    chunk({ delta: delta({ content: "hi" }) }),
    chunk({ delta: delta(), finishReason: "stop" }),
  ]);
  const textResult = await new ChatCompletionStreamer(
    new FakeCompletions(textOnly),
  ).complete({ model: "model", messages: [], tools: [] });
  assert.deepEqual(textResult.messageDict(), {
    role: "assistant",
    content: "hi",
  });
});
