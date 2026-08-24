import test from "node:test";
import assert from "node:assert/strict";

import { CancelToken } from "../src/cancellation.ts";
import {
  AdapterRegistry,
  DeepSeekAdapter,
  ModelError,
  OpenAIAdapter,
  classifyModelError,
  defaultAdapterRegistry,
  modelErrorKind,
  portableMessage,
  type ChatClientLike,
  type ModelAdapter,
  type ModelRequest,
  type ThinkingSettings,
} from "../src/model-adapter.ts";
import {
  ModelStreamCancelled,
  ModelStreamError,
  type StreamResult,
} from "../src/model-stream.ts";

// --- Fakes (mirror scripts/model-stream.test.ts helpers) ---------------------

function delta(
  init: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: unknown[] | null;
  } = {},
): Record<string, unknown> {
  return {
    content: init.content ?? null,
    reasoning_content: init.reasoning_content ?? null,
    tool_calls: init.tool_calls ?? null,
  };
}

function chunk(
  init: { delta?: unknown; finish_reason?: string | null; usage?: unknown } = {},
): Record<string, unknown> {
  const deltaPart = init.delta ?? null;
  const finishReason = init.finish_reason ?? null;
  const choices =
    deltaPart !== null || finishReason !== null
      ? [{ delta: deltaPart, finish_reason: finishReason }]
      : [];
  return { choices, usage: init.usage ?? null };
}

function toolFragment(
  index: number,
  init: {
    call_id?: string | null;
    name?: string | null;
    arguments?: string | null;
    call_type?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    index,
    id: init.call_id ?? null,
    type: init.call_type ?? null,
    function: { name: init.name ?? null, arguments: init.arguments ?? null },
  };
}

class FakeStream {
  closed = false;
  private readonly chunks: unknown[];

  constructor(chunks: unknown[]) {
    this.chunks = chunks;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    yield* this.chunks;
  }

  close(): void {
    this.closed = true;
  }
}

/** A fake endpoint answering every request with the queued responses/errors. */
class FakeCompletions {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = responses;
  }

  create(request: Record<string, unknown>): unknown {
    this.requests.push(request);
    const response =
      this.responses.length > 1
        ? this.responses.shift()
        : this.responses[0];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

function fakeClient(completions: FakeCompletions): ChatClientLike {
  return { chat: { completions } };
}

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const NEUTRAL_MESSAGES: Array<Record<string, unknown>> = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "hello" },
];
const NEUTRAL_TOOLS: Array<Record<string, unknown>> = [
  { type: "function", function: { name: "read" } },
];

function neutralRequest(
  overrides: Partial<ModelRequest> = {},
  onDelta?: (kind: string, payload: Record<string, unknown>) => void,
): ModelRequest {
  return {
    model: "test-model",
    messages: NEUTRAL_MESSAGES,
    tools: NEUTRAL_TOOLS,
    toolChoice: "auto",
    onDelta: onDelta ?? null,
    ...overrides,
  };
}

function contractStream(): FakeStream {
  return new FakeStream([
    chunk({ delta: delta({ reasoning_content: "thinking " }) }),
    chunk({
      delta: delta({
        content: "partial ",
        reasoning_content: "more",
        tool_calls: [
          toolFragment(0, {
            call_id: "call_1",
            name: "read",
            arguments: '{"path":',
          }),
        ],
      }),
    }),
    chunk({
      delta: delta({
        content: "answer",
        tool_calls: [toolFragment(0, { arguments: '"a.txt"}' })],
      }),
      finish_reason: "tool_calls",
    }),
    chunk({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  ]);
}

const ADAPTERS: Array<[string, () => ModelAdapter]> = [
  ["openai", () => new OpenAIAdapter()],
  ["deepseek", () => new DeepSeekAdapter()],
];

// --- Contract: same neutral request through both adapters ----------------------

for (const [name, makeAdapter] of ADAPTERS) {
  test(`${name}: streams normalized text/reasoning/tool-call/usage/finish`, async () => {
    const completions = new FakeCompletions([contractStream()]);
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const result = await makeAdapter().complete(
      fakeClient(completions),
      neutralRequest({}, (kind, payload) => events.push({ kind, payload })),
    );

    // The wire request is the unchanged Chat Completions streaming shape.
    assert.deepEqual(completions.requests[0], {
      model: "test-model",
      messages: NEUTRAL_MESSAGES,
      tools: NEUTRAL_TOOLS,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
    });

    // Normalized delta events (text deltas may be coalesced).
    const joined = (kind: string): string =>
      events
        .filter((event) => event.kind === kind)
        .map((event) => String(event.payload["text"]))
        .join("");
    assert.equal(joined("model_text_delta"), "partial answer");
    assert.equal(joined("model_reasoning_delta"), "thinking more");
    const toolDeltas = events.filter(
      (event) => event.kind === "model_tool_call_delta",
    );
    assert.deepEqual(
      toolDeltas.map((event) => event.payload["arguments"]),
      ['{"path":', '"a.txt"}'],
    );
    assert.ok(
      events.some((event) => event.kind === "model_response_validating"),
    );

    // Normalized finish, tool calls, and usage on the result.
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.content, "partial answer");
    assert.equal(result.reasoningContent, "thinking more");
    assert.deepEqual(result.toolCalls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: '{"path":"a.txt"}' },
      },
    ]);
    assert.deepEqual(result.usage, {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  test(`${name}: cancellation is classified, not wrapped as a model error`, async () => {
    const token = new CancelToken();
    token.cancel("user stopped");
    const completions = new FakeCompletions([contractStream()]);
    await assert.rejects(
      makeAdapter().complete(
        fakeClient(completions),
        neutralRequest({ cancelToken: token }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ModelStreamCancelled);
        assert.ok(!(error instanceof ModelError));
        return true;
      },
    );
  });
}

test("both adapters produce identical wire requests and results", async () => {
  const results: Array<{
    request: Record<string, unknown> | undefined;
    result: StreamResult;
  }> = [];
  for (const [, makeAdapter] of ADAPTERS) {
    const completions = new FakeCompletions([contractStream()]);
    const result = await makeAdapter().complete(
      fakeClient(completions),
      neutralRequest(),
    );
    results.push({ request: completions.requests[0], result });
  }
  const [openai, deepseek] = results;
  assert.ok(openai !== undefined && deepseek !== undefined);
  assert.deepEqual(deepseek.request, openai.request);
  assert.deepEqual(deepseek.result.messageDict(), openai.result.messageDict());
  assert.equal(deepseek.result.finishReason, openai.result.finishReason);
  assert.deepEqual(deepseek.result.usage, openai.result.usage);
});

// --- Error taxonomy -------------------------------------------------------------

test("error taxonomy: status and message signals classify correctly", () => {
  assert.equal(
    classifyModelError(statusError(401, "invalid api key")),
    "authentication",
  );
  assert.equal(classifyModelError(statusError(403, "forbidden")), "authentication");
  assert.equal(
    classifyModelError(Object.assign(new Error("nope"), { status_code: 401 })),
    "authentication",
  );
  assert.equal(classifyModelError(statusError(429, "slow down")), "rate_limited");
  assert.equal(
    classifyModelError(
      statusError(400, "This model's maximum context length is 8192 tokens"),
    ),
    "context_overflow",
  );
  assert.equal(
    classifyModelError(new Error("context window exceeded")),
    "context_overflow",
  );
  assert.equal(classifyModelError(statusError(500, "boom")), "server");
  assert.equal(classifyModelError(statusError(503, "overloaded")), "server");
  assert.equal(
    classifyModelError(new Error("network unavailable")),
    "retryable",
  );
  assert.equal(classifyModelError(new Error("something odd")), "retryable");
  // Classification walks the cause chain, as the streamer wraps SDK errors.
  assert.equal(
    classifyModelError(
      new ModelStreamError("wrapped", { cause: statusError(401, "bad key") }),
    ),
    "authentication",
  );
});

for (const [name, makeAdapter] of ADAPTERS) {
  test(`${name}: endpoint errors normalize into the taxonomy`, async (t) => {
    const cases: Array<[Error, string]> = [
      [statusError(401, "invalid api key"), "authentication"],
      [statusError(429, "rate limited"), "rate_limited"],
      [
        statusError(400, "maximum context length exceeded"),
        "context_overflow",
      ],
      [statusError(500, "internal error"), "server"],
      [new Error("fetch failed"), "retryable"],
    ];
    for (const [endpointError, kind] of cases) {
      await t.test(kind, async () => {
        const completions = new FakeCompletions([endpointError]);
        await assert.rejects(
          makeAdapter().complete(fakeClient(completions), neutralRequest()),
          (error: unknown) => {
            assert.ok(error instanceof ModelError);
            assert.equal((error as ModelError).kind, kind);
            assert.equal(modelErrorKind(error), kind);
            assert.equal((error as ModelError).hadDelta, false);
            return true;
          },
        );
      });
    }
  });
}

// --- DeepSeek specifics -----------------------------------------------------------

test("deepseek: assistant message dict replays reasoning_content", async () => {
  const completions = new FakeCompletions([
    new FakeStream([
      chunk({ delta: delta({ reasoning_content: "private reasoning" }) }),
      chunk({
        delta: delta({
          tool_calls: [
            toolFragment(0, {
              call_id: "call_1",
              name: "read",
              arguments: "{}",
            }),
          ],
        }),
        finish_reason: "tool_calls",
      }),
    ]),
  ]);
  const result = await new DeepSeekAdapter().complete(
    fakeClient(completions),
    neutralRequest(),
  );

  const message = result.messageDict();
  assert.equal(message["reasoning_content"], "private reasoning");
  // Tool-call empty-content convention: no content key when there was none.
  assert.ok(!("content" in message));
  assert.ok(Array.isArray(message["tool_calls"]));
});

test("switchModel portability: downgrade strips reasoning_content", async () => {
  const completions = new FakeCompletions([
    new FakeStream([
      chunk({
        delta: delta({
          content: "done",
          reasoning_content: "private reasoning",
        }),
        finish_reason: "stop",
      }),
    ]),
  ]);
  const result = await new DeepSeekAdapter().complete(
    fakeClient(completions),
    neutralRequest(),
  );
  const history = [result.messageDict(), { role: "user", content: "next" }];

  // Same-provider continuation keeps the opaque replay state.
  assert.equal(history[0]?.["reasoning_content"], "private reasoning");
  // switchModel maps history through portableMessage, discarding it.
  const portable = history.map((message) => portableMessage(message));
  assert.ok(
    portable.every((message) => !("reasoning_content" in message)),
  );
  assert.equal(portable[0]?.["content"], "done");
  assert.deepEqual(portable[1], { role: "user", content: "next" });
});

test("deepseek: thinking settings validate and translate to the wire", async () => {
  const completions = new FakeCompletions([
    new FakeStream([
      chunk({ delta: delta({ content: "ok" }), finish_reason: "stop" }),
    ]),
  ]);
  await new DeepSeekAdapter().complete(
    fakeClient(completions),
    neutralRequest({ thinking: { enabled: true } }),
  );
  assert.deepEqual(completions.requests[0]?.["thinking"], {
    type: "enabled",
  });

  await assert.rejects(
    new DeepSeekAdapter().complete(
      fakeClient(new FakeCompletions([])),
      neutralRequest({
        thinking: { enabled: "yes" } as unknown as ThinkingSettings,
      }),
    ),
    ModelStreamError,
  );
});

test("openai: thinking settings are rejected as unsupported", async () => {
  const adapter = new OpenAIAdapter();
  assert.equal(adapter.capabilities.thinkingSettings, false);
  await assert.rejects(
    adapter.complete(
      fakeClient(new FakeCompletions([])),
      neutralRequest({ thinking: { enabled: true } }),
    ),
    ModelStreamError,
  );
});

// --- Registry ---------------------------------------------------------------------

test("registry resolves known providers and falls back to openai", () => {
  const registry = new AdapterRegistry();
  const openai = new OpenAIAdapter();
  const deepseek = new DeepSeekAdapter();
  registry.register(openai);
  registry.register(deepseek);

  assert.equal(registry.resolve("openai"), openai);
  assert.equal(registry.resolve("deepseek"), deepseek);
  assert.equal(registry.resolve(null), openai);
  assert.equal(registry.resolve(undefined), openai);
  assert.equal(registry.resolve("unknown-provider"), openai);
});

test("default registry has both built-in adapters", () => {
  assert.ok(defaultAdapterRegistry.resolve("openai") instanceof OpenAIAdapter);
  assert.ok(
    defaultAdapterRegistry.resolve("deepseek") instanceof DeepSeekAdapter,
  );
  assert.equal(
    defaultAdapterRegistry.resolve("deepseek").capabilities.reasoningReplay,
    true,
  );
});
