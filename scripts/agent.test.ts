import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AgentCancelled,
  AgentError,
  CodingAgent,
  type AgentContext,
} from "../packages/core/agent-runtime/src/index.ts";
import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import { EventBus, EventKind } from "../packages/core/runtime-protocol/src/index.ts";
import {
  type ToolDefinition,
  type ToolResult,
  type ToolSpec,
} from "../packages/core/tools/src/index.ts";
import { OpenAICompatibleAdapter } from "@laohuang/llm-openai-compatible";
import { createTestToolRegistry } from "./test-tool-registry.ts";

// --- Fakes -------------------------------------------------------------------

class FakeToolCall {
  readonly id: string;
  readonly type = "function";
  readonly function: { name: string; arguments: string };

  constructor(id: string, name: string, args: string) {
    this.id = id;
    this.function = { name, arguments: args };
  }
}

class FakeMessage {
  readonly content: string | null;
  readonly tool_calls: FakeToolCall[] | null;
  readonly usage: unknown;

  constructor(
    init: {
      content?: string | null;
      tool_calls?: FakeToolCall[] | null;
      usage?: unknown;
    } = {},
  ) {
    this.content = init.content ?? null;
    this.tool_calls = init.tool_calls ?? null;
    this.usage = init.usage ?? null;
  }
}

class FakeCompletions {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly messages: Iterator<FakeMessage>;

  constructor(messages: FakeMessage[]) {
    this.messages = messages[Symbol.iterator]();
  }

  create(request: Record<string, unknown>): Record<string, unknown> {
    this.requests.push(request);
    const message = this.messages.next().value as FakeMessage;
    return { choices: [{ message }], usage: message.usage };
  }
}

class FailingCompletions {
  create(): never {
    throw new Error("network unavailable");
  }
}

class AuthenticationFailure extends Error {
  readonly status_code = 401;

  constructor(message: string) {
    super(message);
    this.name = "AuthenticationFailure";
  }
}

class AuthenticationFailingCompletions {
  create(): never {
    throw new AuthenticationFailure("invalid API key");
  }
}

function fakeClient(...messages: FakeMessage[]) {
  const completions = new FakeCompletions(messages);
  return { chat: { completions }, completions };
}

function fakeModelAdapter(
  client: ReturnType<typeof fakeClient>,
  provider = "openai",
): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    provider,
    capabilities: {
      streaming: true,
      reasoningReplay: provider === "deepseek",
      thinkingSettings: provider === "deepseek",
    },
    client,
  });
}

// --- Streaming fakes (mirrors tests/test_model_stream.py helpers) ------------

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

  *[Symbol.iterator](): Iterator<unknown> {
    yield* this.chunks;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeStreamCompletions {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly responses: Iterator<unknown>;

  constructor(responses: unknown[]) {
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

class CancellingTools {
  readonly definitions: ToolDefinition[] = [
    { type: "function", function: { name: "read" } } as ToolDefinition,
  ];
  readonly orderedSpecs: readonly ToolSpec[] = [];
  private readonly token: CancelToken;

  constructor(token: CancelToken) {
    this.token = token;
  }

  executionMode(): undefined {
    return undefined;
  }

  execute(): ToolResult {
    this.token.cancel("cancel during tool");
    return { ok: false, status: "cancelled", error: "cancel during tool" };
  }
}

// --- Helpers -----------------------------------------------------------------

function tempDir(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), "agent-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

interface CollectedEvent {
  type: string;
  payload: Record<string, unknown>;
}

function collectEvents(events: CollectedEvent[]) {
  return (eventType: string, payload: Record<string, unknown>): void => {
    events.push({ type: eventType, payload });
  };
}

function requestMessages(
  completions: { requests: Array<Record<string, unknown>> },
  index: number,
): Array<Record<string, unknown>> {
  return completions.requests[index]?.["messages"] as Array<
    Record<string, unknown>
  >;
}

// --- Tests (translated from tests/test_agent.py) ------------------------------

test("model can switch without losing conversation history", async (t) => {
  const directory = tempDir(t);
  const originalClient = fakeClient(new FakeMessage({ content: "hello" }));
  const replacementClient = fakeClient(
    new FakeMessage({ content: "switched" }),
  );
  const events: CollectedEvent[] = [];
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(originalClient),
    model: "old-model",
    tools: createTestToolRegistry(directory),
    onAgentEvent: collectEvents(events),
  });
  await agent.run("first turn");

  agent.switchModel({
    modelAdapter: fakeModelAdapter(replacementClient),
    model: "new-model",
    provider: "openai",
  });
  const answer = await agent.run("second turn");

  assert.equal(answer, "switched");
  assert.equal(
    replacementClient.completions.requests[0]?.["model"],
    "new-model",
  );
  assert.ok(
    agent.messages.some((message) => message["content"] === "first turn"),
  );
  assert.ok(events.some((event) => event.type === "model_switched"));
});

test("user receives a direct model response", async (t) => {
  const directory = tempDir(t);
  const client = fakeClient(new FakeMessage({ content: "Hello from the model" }));
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  const result = await agent.run("Say hello");

  assert.equal(result, "Hello from the model");
});

test("agent executes a tool and returns the follow-up response", async (t) => {
  const directory = tempDir(t);
  writeFileSync(path.join(directory, "answer.txt"), "42", "utf8");
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [new FakeToolCall("call_1", "read", '{"path":"answer.txt"}')],
    }),
    new FakeMessage({ content: "The answer is 42." }),
  );
  const events: Array<[string, Record<string, unknown>, ToolResult]> = [];
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    onToolEvent: (name, args, result) => {
      events.push([name, args, result]);
    },
  });

  const result = await agent.run("Read the answer");

  assert.equal(result, "The answer is 42.");
  const toolMessage = requestMessages(client.completions, 1).at(-1)!;
  assert.equal(toolMessage["role"], "tool");
  assert.equal(toolMessage["tool_call_id"], "call_1");
  assert.ok(String(toolMessage["content"]).includes('"content":"42"'));
  assert.equal(events[0]?.[0], "read");
  assert.deepEqual(events[0]?.[1], { path: "answer.txt" });
  assert.equal(events[0]?.[2]["ok"], true);
});

test("agent does not limit tool rounds or model requests", async (t) => {
  const directory = tempDir(t);
  const calls = Array.from(
    { length: 21 },
    (_, index) =>
      new FakeMessage({
        tool_calls: [
          new FakeToolCall(
            `call_${index}`,
            "read",
            JSON.stringify({ path: `missing-${index}` }),
          ),
        ],
      }),
  );
  const client = fakeClient(
    ...calls,
    new FakeMessage({ content: "Finished after 21 tool rounds." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  const result = await agent.run("Read every missing path");

  assert.equal(result, "Finished after 21 tool rounds.");
  assert.equal(client.completions.requests.length, 22);
  assert.ok(
    client.completions.requests.every(
      (request) => request["tool_choice"] === "auto",
    ),
  );
});

test("repeated tool call forces a final answer after three matches", async (t) => {
  const directory = tempDir(t);
  const call = (callId: string) =>
    new FakeMessage({
      tool_calls: [new FakeToolCall(callId, "read", '{"path":"missing"}')],
    });
  const events: CollectedEvent[] = [];
  const eventBus = new EventBus();
  const context: AgentContext = {
    eventBus,
    sessionId: "session-1",
    taskId: "task-1",
    cancelToken: new CancelToken(),
  };
  const client = fakeClient(
    call("call_1"),
    call("call_2"),
    call("call_3"),
    new FakeMessage({ content: "No more tool calls." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    onAgentEvent: collectEvents(events),
  });

  const result = await agent.run("Repeat forever", context);

  assert.equal(result, "No more tool calls.");
  assert.equal(client.completions.requests.length, 4);
  assert.equal(client.completions.requests.at(-1)?.["tool_choice"], "none");
  const guard = events.find((event) => event.type === "agent_guard_triggered");
  assert.ok(guard !== undefined);
  assert.ok(String(guard.payload["reason"]).includes("repeated tool call"));
  assert.equal(guard.payload["tool_rounds"], 3);
  const canonical = eventBus.drain();
  assert.ok(
    canonical.some(
      (event) =>
        event.kind === EventKind.AgentGuardTriggered &&
        String(event.payload["reason"]).includes("repeated tool call"),
    ),
  );
  const summaries = canonical.filter(
    (event) => event.kind === EventKind.ModelResponseSummary,
  );
  assert.equal(summaries.length, 4);
  assert.deepEqual(summaries[0]?.payload["tool_names"], ["read"]);
  assert.ok(Number(summaries[0]?.payload["total_tokens"]) > 0);
});

test("repeated tool counter resets after a different result", async (t) => {
  const directory = tempDir(t);
  writeFileSync(path.join(directory, "one.txt"), "one", "utf8");
  writeFileSync(path.join(directory, "two.txt"), "two", "utf8");
  const call = (callId: string, filePath: string) =>
    new FakeMessage({
      tool_calls: [
        new FakeToolCall(callId, "read", JSON.stringify({ path: filePath })),
      ],
    });
  const client = fakeClient(
    call("call_1", "one.txt"),
    call("call_2", "two.txt"),
    call("call_3", "one.txt"),
    call("call_4", "one.txt"),
    new FakeMessage({ content: "Finished normally." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  assert.equal(await agent.run("Read files"), "Finished normally.");
  assert.ok(
    client.completions.requests.every(
      (request) => request["tool_choice"] === "auto",
    ),
  );
});

test("token budget forces final without committing unmatched calls", async (t) => {
  const directory = tempDir(t);
  const first = new FakeMessage({
    tool_calls: [new FakeToolCall("call_1", "read", '{"path":"missing"}')],
    usage: { total_tokens: 101 },
  });
  const client = fakeClient(first, new FakeMessage({ content: "Budget reached." }));
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    maxTotalTokens: 100,
  });

  const result = await agent.run("Spend tokens");

  assert.equal(result, "Budget reached.");
  assert.equal(client.completions.requests.at(-1)?.["tool_choice"], "none");
  assert.ok(agent.messages.every((message) => !message["tool_calls"]));
});

test("elapsed budget can force no-tool answer immediately", async (t) => {
  const directory = tempDir(t);
  const client = fakeClient(new FakeMessage({ content: "Time limit." }));
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    maxElapsedSeconds: 1e-12,
  });

  assert.equal(await agent.run("No time"), "Time limit.");
  assert.equal(client.completions.requests[0]?.["tool_choice"], "none");
});

test("failed forced final reports guard counters and reason", async (t) => {
  const directory = tempDir(t);
  const call = (callId: string) =>
    new FakeMessage({
      tool_calls: [new FakeToolCall(callId, "read", '{"path":"missing"}')],
    });
  const client = fakeClient(
    call("call_1"),
    call("call_2"),
    call("call_3"),
    call("call_4"),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  await assert.rejects(agent.run("Ignore the guard"), (error: unknown) => {
    assert.ok(error instanceof AgentError);
    assert.match(
      (error as Error).message,
      /repeated tool call detected.*Tool rounds: 3; model requests: 4/,
    );
    return true;
  });

  assert.equal(agent.messages.at(-1)?.["role"], "tool");
});

test("multiple tool calls run in returned order", async (t) => {
  const directory = tempDir(t);
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [
        new FakeToolCall(
          "call_1",
          "write",
          '{"path":"result.txt","content":"done"}',
        ),
        new FakeToolCall("call_2", "read", '{"path":"result.txt"}'),
      ],
    }),
    new FakeMessage({ content: "Finished." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  const result = await agent.run("Create and read a result");

  assert.equal(result, "Finished.");
  assert.equal(
    readFileSync(path.join(directory, "result.txt"), "utf8"),
    "done",
  );
  const toolMessages = requestMessages(client.completions, 1).slice(-2);
  assert.deepEqual(
    toolMessages.map((message) => message["tool_call_id"]),
    ["call_1", "call_2"],
  );
});

test("tool batch executes concurrently and returns source order", async (t) => {
  const directory = tempDir(t);
  const waitForSecond =
    "touch first.started; " +
    "for _ in {1..100}; do " +
    "[ -f second.started ] && { printf first; exit 0; }; " +
    "sleep 0.01; done; exit 1";
  const waitForFirst =
    "touch second.started; " +
    "for _ in {1..100}; do " +
    "[ -f first.started ] && { printf second; exit 0; }; " +
    "sleep 0.01; done; exit 1";
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [
        new FakeToolCall("call_1", "bash", JSON.stringify({ command: waitForSecond, description: "wait for second" })),
        new FakeToolCall("call_2", "bash", JSON.stringify({ command: waitForFirst, description: "wait for first" })),
      ],
    }),
    new FakeMessage({ content: "Finished." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory, { bashTimeoutSeconds: 2 }),
  });

  await agent.run("Run both checks");

  const toolMessages = requestMessages(client.completions, 1).slice(-2);
  const results = toolMessages.map(
    (message) => JSON.parse(String(message["content"])) as ToolResult,
  );
  assert.deepEqual(
    toolMessages.map((message) => message["tool_call_id"]),
    ["call_1", "call_2"],
  );
  assert.deepEqual(
    results.map((result) => [result["ok"], result["stdout"]]),
    [
      [true, "first"],
      [true, "second"],
    ],
  );
});

test("global sequential mode runs tool calls one by one", async (t) => {
  const directory = tempDir(t);
  const waitForSecond =
    "touch first.started; " +
    "for _ in {1..10}; do " +
    "[ -f second.started ] && exit 0; sleep 0.01; " +
    "done; exit 1";
  const waitForFirst = "touch second.started; [ -f first.started ]";
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [
        new FakeToolCall("call_1", "bash", JSON.stringify({ command: waitForSecond, description: "wait for second" })),
        new FakeToolCall("call_2", "bash", JSON.stringify({ command: waitForFirst, description: "wait for first" })),
      ],
    }),
    new FakeMessage({ content: "Finished." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory, { bashTimeoutSeconds: 1 }),
    toolExecution: "sequential",
  });

  await agent.run("Run sequentially");

  const toolMessages = requestMessages(client.completions, 1).slice(-2);
  const results = toolMessages.map(
    (message) => JSON.parse(String(message["content"])) as ToolResult,
  );
  assert.deepEqual(
    results.map((result) => result["ok"]),
    [false, true],
  );
});

test("one sequential tool forces the whole batch to run sequentially", async (t) => {
  const directory = tempDir(t);
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [
        new FakeToolCall(
          "call_1",
          "bash",
          JSON.stringify({ command: "sleep 0.1; touch first.done", description: "create marker" }),
        ),
        new FakeToolCall("call_2", "bash", JSON.stringify({ command: "[ -f first.done ]", description: "check marker" })),
      ],
    }),
    new FakeMessage({ content: "Finished." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory, {
      executionModes: { bash: "sequential" },
    }),
  });

  await agent.run("Run with a sequential tool");

  const toolMessages = requestMessages(client.completions, 1).slice(-2);
  const results = toolMessages.map(
    (message) => JSON.parse(String(message["content"])) as ToolResult,
  );
  assert.deepEqual(
    results.map((result) => result["ok"]),
    [true, true],
  );
});

test("completion events are live while messages stay source ordered", async (t) => {
  const directory = tempDir(t);
  const events: CollectedEvent[] = [];
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [
        new FakeToolCall("call_1", "bash", '{"command":"sleep 0.1; printf slow","description":"slow print"}'),
        new FakeToolCall("call_2", "bash", '{"command":"printf fast","description":"fast print"}'),
      ],
    }),
    new FakeMessage({ content: "Finished." }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    onAgentEvent: collectEvents(events),
  });

  await agent.run("Run a slow and a fast tool");

  const completedIds = events
    .filter((event) => event.type === "tool_result")
    .map((event) => event.payload["tool_call_id"]);
  const toolMessages = requestMessages(client.completions, 1).slice(-2);
  assert.deepEqual(completedIds, ["call_2", "call_1"]);
  assert.deepEqual(
    toolMessages.map((message) => message["tool_call_id"]),
    ["call_1", "call_2"],
  );
});

test("consecutive user turns share conversation history", async (t) => {
  const directory = tempDir(t);
  const client = fakeClient(
    new FakeMessage({ content: "First answer" }),
    new FakeMessage({ content: "Second answer" }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  await agent.run("First question");
  await agent.run("Second question");

  const secondRequest = requestMessages(client.completions, 1);
  assert.deepEqual(
    secondRequest.map((message) => message["role"]),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(secondRequest.at(-2)?.["content"], "First answer");
});

test("api failures become actionable agent errors", async (t) => {
  const directory = tempDir(t);
  const completions = new FailingCompletions();
  const client = { chat: { completions } };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
  });

  await assert.rejects(agent.run("Hello"), (error: unknown) => {
    assert.ok(error instanceof AgentError);
    assert.match(
      (error as Error).message,
      /Model request failed: network unavailable/,
    );
    return true;
  });
});

test("authentication failures point to provider login", async (t) => {
  const directory = tempDir(t);
  const client = { chat: { completions: new AuthenticationFailingCompletions() } };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "deepseek-v4-flash",
    provider: "deepseek",
    tools: createTestToolRegistry(directory),
  });

  await assert.rejects(agent.run("Hello"), (error: unknown) => {
    assert.ok(error instanceof AgentError);
    assert.match((error as Error).message, /\/login deepseek/);
    return true;
  });
});

test("events group batch tool calls under one model round", async (t) => {
  const directory = tempDir(t);
  const events: CollectedEvent[] = [];
  const client = fakeClient(
    new FakeMessage({
      tool_calls: [
        new FakeToolCall(
          "call_1",
          "write",
          '{"path":"trace.txt","content":"hello"}',
        ),
        new FakeToolCall("call_2", "read", '{"path":"trace.txt"}'),
      ],
    }),
    new FakeMessage({ content: "Done" }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    onAgentEvent: collectEvents(events),
  });

  await agent.run("Trace this");

  const modelResponses = events
    .filter((event) => event.type === "model_response")
    .map((event) => event.payload);
  const toolStarts = events
    .filter((event) => event.type === "tool_start")
    .map((event) => event.payload);
  assert.equal(modelResponses[0]?.["round"], 1);
  assert.equal(modelResponses[0]?.["tool_call_count"], 2);
  assert.deepEqual(modelResponses[0]?.["tool_names"], ["write", "read"]);
  assert.deepEqual(
    toolStarts.map((event) => [event["round"], event["index"]]),
    [
      [1, 1],
      [1, 2],
    ],
  );
  assert.equal(
    (toolStarts[0]?.["arguments"] as Record<string, unknown>)["content"],
    "<5 chars>",
  );
  assert.equal(modelResponses[1]?.["round"], 2);
  assert.equal(modelResponses[1]?.["tool_call_count"], 0);
});

test("events distinguish consecutive user turns", async (t) => {
  const directory = tempDir(t);
  const events: CollectedEvent[] = [];
  const client = fakeClient(
    new FakeMessage({ content: "First" }),
    new FakeMessage({ content: "Second" }),
  );
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "test-model",
    tools: createTestToolRegistry(directory),
    onAgentEvent: collectEvents(events),
  });

  await agent.run("Question one");
  await agent.run("Question two");

  const modelRequests = events
    .filter((event) => event.type === "model_request")
    .map((event) => event.payload);
  assert.deepEqual(
    modelRequests.map((event) => [event["turn"], event["round"]]),
    [
      [1, 1],
      [2, 1],
    ],
  );
});

// --- Tests (translated from tests/test_model_stream.py agent-level tests) -----

test("agent preserves reasoning for tool round then strips on switch", async (t) => {
  const directory = tempDir(t);
  const first = new FakeStream([
    chunk({ delta: delta({ reasoning_content: "private reasoning" }) }),
    chunk({
      delta: delta({
        tool_calls: [
          toolFragment(0, {
            call_id: "call_1",
            name: "read",
            arguments: '{"path":"missing.txt"}',
            call_type: "function",
          }),
        ],
      }),
    }),
    chunk({ delta: delta(), finish_reason: "tool_calls" }),
  ]);
  const second = new FakeStream([
    chunk({ delta: delta({ content: "finished" }) }),
    chunk({ delta: delta(), finish_reason: "stop" }),
  ]);
  const completions = new FakeStreamCompletions([first, second]);
  const client = { chat: { completions } };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "deepseek-reasoner",
    provider: "deepseek",
    tools: createTestToolRegistry(directory),
  });

  assert.equal(await agent.run("read it"), "finished");

  const assistant = requestMessages(completions, 1).at(-2)!;
  assert.equal(assistant["reasoning_content"], "private reasoning");
  agent.switchModel({
    modelAdapter: fakeModelAdapter(client),
    model: "gpt-test",
    provider: "openai",
  });
  assert.ok(
    agent.messages.every((message) => !("reasoning_content" in message)),
  );
});

test("failed attempt is not committed to agent history", async (t) => {
  const directory = tempDir(t);
  const client = {
    chat: {
      completions: new FakeStreamCompletions([
        new FakeStream([
          chunk({ delta: delta({ content: "visible partial" }) }),
          chunk({ delta: delta(), finish_reason: "length" }),
        ]),
      ]),
    },
  };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "model",
    tools: createTestToolRegistry(directory),
  });

  await assert.rejects(agent.run("hello"), (error: unknown) => {
    assert.ok(error instanceof AgentError);
    return true;
  });

  assert.deepEqual(
    agent.messages.map((message) => message["role"]),
    ["system", "user"],
  );
  assert.ok(
    agent.messages.every((message) => message["content"] !== "visible partial"),
  );
});

test("cancel at history commit boundary discards assistant", async (t) => {
  const directory = tempDir(t);
  const stream = new FakeStream([
    chunk({ delta: delta({ content: "complete but cancelled" }) }),
    chunk({ delta: delta(), finish_reason: "stop" }),
  ]);
  const client = { chat: { completions: new FakeStreamCompletions([stream]) } };

  const context: AgentContext = {
    cancelToken: new CancelToken(),
    sessionId: "session-1",
    taskId: "task-1",
    eventBus: new EventBus(),
    commitInput: (append) => {
      append();
      return true;
    },
    commitIfActive: () => false,
  };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "model",
    tools: createTestToolRegistry(directory),
  });

  await assert.rejects(agent.run("hello", context), (error: unknown) => {
    assert.ok(error instanceof AgentCancelled);
    assert.match((error as Error).message, /history commit/);
    return true;
  });

  assert.deepEqual(
    agent.messages.map((message) => message["role"]),
    ["system", "user"],
  );
  assert.ok(
    agent.messages.every(
      (message) => message["content"] !== "complete but cancelled",
    ),
  );
});

test("agent publishes canonical model events", async (t) => {
  const directory = tempDir(t);
  const eventBus = new EventBus();
  const context: AgentContext = {
    eventBus,
    sessionId: "session-1",
    taskId: "task-1",
    cancelToken: new CancelToken(),
  };
  const stream = new FakeStream([
    chunk({ delta: delta({ content: "hello" }) }),
    chunk({ delta: delta(), finish_reason: "stop" }),
  ]);
  const client = { chat: { completions: new FakeStreamCompletions([stream]) } };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "model",
    tools: createTestToolRegistry(directory),
  });

  assert.equal(await agent.run("hi", context), "hello");

  const events = eventBus.drain();
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      EventKind.ModelRequestStarted,
      EventKind.ModelTextDelta,
      EventKind.ModelResponseValidating,
      EventKind.ModelResponseSummary,
      EventKind.ModelResponseCommitted,
    ],
  );
  assert.ok(events.every((event) => event.task_id === "task-1"));
  const correlationIds = new Set(events.map((event) => event.correlation_id));
  assert.equal(correlationIds.size, 1);
  assert.ok(!correlationIds.has(null));
});

test("cancelled tool batch keeps history pairs", async (t) => {
  const directory = tempDir(t);
  void directory;
  const stream = new FakeStream([
    chunk({
      delta: delta({
        tool_calls: [
          toolFragment(0, {
            call_id: "call_1",
            name: "read",
            arguments: '{"path":"file.txt"}',
            call_type: "function",
          }),
        ],
      }),
    }),
    chunk({ delta: delta(), finish_reason: "tool_calls" }),
  ]);
  const token = new CancelToken();
  const client = { chat: { completions: new FakeStreamCompletions([stream]) } };
  const agent = new CodingAgent({
    modelAdapter: fakeModelAdapter(client),
    model: "model",
    tools: new CancellingTools(token),
  });

  await assert.rejects(
    agent.run("read", null, { cancelToken: token }),
    (error: unknown) => {
      assert.ok(error instanceof AgentCancelled);
      assert.match((error as Error).message, /cancel during tool/);
      return true;
    },
  );

  assert.deepEqual(
    agent.messages.map((message) => message["role"]),
    ["system", "user", "assistant", "tool"],
  );
  const toolCalls = agent.messages.at(-2)?.["tool_calls"] as Array<
    Record<string, unknown>
  >;
  assert.equal(toolCalls[0]?.["id"], "call_1");
  assert.equal(agent.messages.at(-1)?.["tool_call_id"], "call_1");
  assert.ok(
    String(agent.messages.at(-1)?.["content"]).includes('"status":"cancelled"'),
  );
});
