import test from "node:test";
import assert from "node:assert/strict";

import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import {
  ModelError,
  ModelStreamCancelled,
  ModelStreamError,
  classifyModelError,
  modelErrorKind,
  portableMessage,
  type ModelAdapter,
  type ModelRequest,
  type ThinkingSettings,
  type StreamResult,
} from "@laohuang/llm";
import {
  AdapterRegistry,
  OpenAICompatibleAdapter,
  defaultAdapterRegistry,
  type ChatClientLike,
} from "@laohuang/llm-openai-compatible";

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

const OPENAI_CAPABILITIES = {
  streaming: true,
  reasoningReplay: false,
  thinkingSettings: false,
};
const DEEPSEEK_CAPABILITIES = {
  streaming: true,
  reasoningReplay: true,
  thinkingSettings: true,
};

function makeOpenAIAdapter(): OpenAICompatibleAdapter {
  return makeOpenAIAdapterWith(new FakeCompletions([]));
}

function makeOpenAIAdapterWith(completions: FakeCompletions): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    provider: "openai",
    capabilities: OPENAI_CAPABILITIES,
    client: fakeClient(completions),
  });
}

function makeDeepSeekAdapter(): OpenAICompatibleAdapter {
  return makeDeepSeekAdapterWith(new FakeCompletions([]));
}

function makeDeepSeekAdapterWith(completions: FakeCompletions): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    provider: "deepseek",
    capabilities: DEEPSEEK_CAPABILITIES,
    client: fakeClient(completions),
  });
}

const ADAPTERS: Array<[string, (completions: FakeCompletions) => ModelAdapter]> = [
  ["openai", makeOpenAIAdapterWith],
  ["deepseek", makeDeepSeekAdapterWith],
];

// --- Contract: same neutral request through both adapters ----------------------

for (const [name, makeAdapter] of ADAPTERS) {
  test(`${name}: streams normalized text/reasoning/tool-call/usage/finish`, async () => {
    const completions = new FakeCompletions([contractStream()]);
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const result = await makeAdapter(completions).runAttempt(
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
      makeAdapter(completions).runAttempt(
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
    const result = await makeAdapter(completions).runAttempt(neutralRequest());
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
          makeAdapter(completions).runAttempt(neutralRequest()),
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
  const result = await makeDeepSeekAdapterWith(completions).runAttempt(
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
  const result = await makeDeepSeekAdapterWith(completions).runAttempt(
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
  await makeDeepSeekAdapterWith(completions).runAttempt(
    neutralRequest({ thinking: { enabled: true } }),
  );
  assert.deepEqual(completions.requests[0]?.["thinking"], {
    type: "enabled",
  });

  await assert.rejects(
    makeDeepSeekAdapterWith(new FakeCompletions([])).runAttempt(
      neutralRequest({
        thinking: { enabled: "yes" } as unknown as ThinkingSettings,
      }),
    ),
    ModelStreamError,
  );
});

test("openai: thinking settings are rejected as unsupported", async () => {
  const adapter = makeOpenAIAdapter();
  assert.equal(adapter.capabilities.thinkingSettings, false);
  await assert.rejects(
    adapter.runAttempt(
      neutralRequest({ thinking: { enabled: true } }),
    ),
    ModelStreamError,
  );
});

// --- Registry ---------------------------------------------------------------------

test("registry resolves known providers and falls back to openai", () => {
  const registry = new AdapterRegistry();
  registry.register({ provider: "openai", capabilities: OPENAI_CAPABILITIES });
  registry.register({ provider: "deepseek", capabilities: DEEPSEEK_CAPABILITIES });
  const client = fakeClient(new FakeCompletions([]));

  assert.equal(registry.resolve("openai", client).name, "openai");
  assert.equal(registry.resolve("deepseek", client).name, "deepseek");
  assert.equal(registry.resolve(null, client).name, "openai");
  assert.equal(registry.resolve(undefined, client).name, "openai");
  assert.equal(registry.resolve("unknown-provider", client).name, "openai");
});

test("default registry has both built-in adapters", () => {
  const client = fakeClient(new FakeCompletions([]));
  assert.ok(
    defaultAdapterRegistry.resolve("openai", client) instanceof OpenAICompatibleAdapter,
  );
  assert.ok(
    defaultAdapterRegistry.resolve("deepseek", client) instanceof OpenAICompatibleAdapter,
  );
  assert.equal(
    defaultAdapterRegistry.resolve("deepseek", client).capabilities.reasoningReplay,
    true,
  );
});
