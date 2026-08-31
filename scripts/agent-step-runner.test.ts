import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentCancelled } from "../packages/core/agent-runtime/src/index.ts";
import type { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import type {
  ModelAdapter,
  ModelInfo,
  ModelProviderInfo,
  ModelRequest,
  ModelResult,
  ReasoningEffort,
} from "@laohuang/llm";
import {
  AgentStepRunner,
  type AgentStepRunnerContext,
} from "../packages/core/agent-runtime/src/core/agent-step-runner.ts";
import { HistoryCommitter } from "../packages/core/agent-runtime/src/core/history-committer.ts";
import { RepeatToolPolicy } from "../packages/core/agent-runtime/src/core/repeat-tool-policy.ts";
import { ModelRuntime } from "@laohuang/llm";
import { ToolRuntime, type ToolResult } from "../packages/core/tools/src/index.ts";

class TestCancelToken {
  cancelled = false;
  reason: string | null = null;

  isCancelled(): boolean {
    return this.cancelled;
  }
}

class StubAdapter implements ModelAdapter {
  readonly name = "stub";
  readonly requests: ModelRequest[] = [];
  private readonly responses: Iterator<ModelResult>;

  constructor(responses: ModelResult[]) {
    this.responses = responses[Symbol.iterator]();
  }

  runAttempt(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request);
    const result = this.responses.next().value;
    if (result === undefined) {
      throw new Error("unexpected model request");
    }
    return Promise.resolve(result);
  }

  listProviders(): readonly ModelProviderInfo[] {
    return [{ id: "openai", name: "OpenAI" }];
  }

  listModels(provider: string): readonly ModelInfo[] {
    return [{ provider, id: "test-model", name: "Test Model" }];
  }
}

function toolCallResult(callId: string): ModelResult {
  return {
    requestId: "request-1",
    finishReason: "tool-calls",
    usage: zeroUsage(),
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      content: [{
        type: "tool-call",
        call: { id: callId, name: "read", arguments: "{\"path\":\"answer.txt\"}" },
      }],
    },
  };
}

function finalResult(content: string): ModelResult {
  return {
    requestId: "request-final",
    finishReason: "stop",
    usage: zeroUsage(),
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      content: [{ type: "text", text: content }],
    },
  };
}

function createRunner(options: {
  messages: ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  adapter: ModelAdapter;
  context?: AgentStepRunnerContext | null;
  contextGovernor?: {
    prepare(input: {
      messages: readonly ModelRequest["messages"][number][];
      tools: readonly unknown[];
      provider: string;
      model: string;
    }): Promise<{ messages: readonly ModelRequest["messages"][number][] }>;
  } | null;
  executeTool?: () => Promise<ToolResult>;
  getReasoningEffort?: () => ReasoningEffort;
}): AgentStepRunner {
  const token = new TestCancelToken() as unknown as CancelToken;
  const context = options.context ?? null;
  const committer = new HistoryCommitter({
    messages: options.messages,
    context,
    cancelToken: token,
    createCancelled: (message) => new AgentCancelled(message),
  });
  return new AgentStepRunner({
    model: "test-model",
    provider: "openai",
    baseUrl: null,
    modelRuntime: new ModelRuntime(options.adapter),
    toolRuntime: new ToolRuntime({
      definitions: [],
      orderedSpecs: [],
      executionMode: () => undefined,
      execute: async () => options.executeTool?.() ?? { ok: true, content: "tool result" },
    }),
    toolDefinitions: [],
    toolExecution: "parallel",
    history: committer,
    contextGovernor: options.contextGovernor ?? null,
    repeatToolPolicy: new RepeatToolPolicy([3, 5, 8]),
    userInput: "first user message",
    context,
    cancelToken: token,
    requestId: null,
    isRequestActive: () => true,
    getReasoningEffort: options.getReasoningEffort ?? (() => "high"),
    onRequestId: () => {},
    emit: () => {},
    emitLegacy: () => {},
    injectBaselineInstructions: () => {},
    discoverForTouchedPaths: () => {},
    onToolEvent: () => {},
    createError: (message, cause) => new Error(message, { cause }),
    createCancelled: (message, cause) => new AgentCancelled(message, { cause }),
  });
}

test("commits the user message through the context before requesting the model", async () => {
  const messages = [{ role: "system", content: "system" }] as ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  const adapter = new StubAdapter([finalResult("complete")]);
  const context: AgentStepRunnerContext & { inputCommitted: boolean } = {
    inputCommitted: false,
    commitInput(append) {
      this.inputCommitted = true;
      append();
      return true;
    },
  };
  const runner = createRunner({ messages, adapter, context });

  assert.equal(await runner.run(), "complete");
  assert.equal(context.inputCommitted, true);
  assert.deepEqual(adapter.requests[0]?.messages.map((message) => message.role), [
    "system",
    "user",
  ]);
});

test("prepares every model request through the context governor", async () => {
  const messages = [{ role: "system", content: "system" }] as ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  const adapter = new StubAdapter([finalResult("complete")]);
  let sawCommittedInput = false;
  const runner = createRunner({
    messages,
    adapter,
    contextGovernor: {
      async prepare(input) {
        sawCommittedInput = input.messages.some(
          (message) => message.role === "user" && message.content === "first user message",
        );
        return { messages: [{ role: "user", content: "governed context" }] };
      },
    },
  });

  assert.equal(await runner.run(), "complete");
  assert.equal(sawCommittedInput, true);
  assert.deepEqual(adapter.requests[0]?.messages, [
    { role: "user", content: "governed context" },
  ]);
});

test("commits the assistant tool call before its paired tool result", async () => {
  const messages = [{ role: "system", content: "system" }] as ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  const adapter = new StubAdapter([toolCallResult("call-1"), finalResult("complete")]);
  const runner = createRunner({ messages, adapter });

  assert.equal(await runner.run(), "complete");
  assert.deepEqual(messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "tool-result",
    "assistant",
  ]);
  assert.deepEqual(messages[3], {
    role: "tool-result",
    toolCallId: "call-1",
    toolName: "read",
    content: JSON.stringify({ ok: true, content: "tool result" }),
    isError: false,
  });
});

test("rejects an unconfirmed final assistant commit after cancellation wins", async () => {
  const messages = [{ role: "system", content: "system" }] as ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  const adapter = new StubAdapter([finalResult("must not commit")]);
  const context: AgentStepRunnerContext = {
    commitIfActive: () => false,
  };
  const runner = createRunner({ messages, adapter, context });

  await assert.rejects(runner.run(), AgentCancelled);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.ok(messages.every((message) => message.role !== "assistant"));
});

test("reads reasoning effort for each model request in a tool loop", async () => {
  const messages = [{ role: "system", content: "system" }] as ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  const adapter = new StubAdapter([toolCallResult("call-1"), finalResult("complete")]);
  let effort: ReasoningEffort = "high";
  const runner = createRunner({
    messages,
    adapter,
    getReasoningEffort: () => effort,
    executeTool: async () => {
      effort = "low";
      return { ok: true, content: "tool result" };
    },
  });

  assert.equal(await runner.run(), "complete");
  assert.deepEqual(
    adapter.requests.map((request) => request.reasoningEffort),
    ["high", "low"],
  );
});

test("commits pending user input only after the tool-result safe point", async () => {
  const messages = [{ role: "system", content: "system" }] as ModelRequest["messages"] extends readonly (infer T)[] ? T[] : never;
  const adapter = new StubAdapter([toolCallResult("call-1"), finalResult("complete")]);
  const order: string[] = [];
  let pendingTaken = false;
  const context: AgentStepRunnerContext = {
    safePoint: () => {
      order.push("safe-point");
      if (pendingTaken) {
        return null;
      }
      pendingTaken = true;
      return { content: "pending user message", eventIds: ["event-2"] };
    },
  };
  const runner = createRunner({
    messages,
    adapter,
    context,
    executeTool: async () => {
      order.push("tool-result");
      return { ok: true, content: "tool result" };
    },
  });

  assert.equal(await runner.run(), "complete");
  assert.deepEqual(order, ["tool-result", "safe-point"]);
  assert.deepEqual(adapter.requests[1]?.messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "tool-result",
    "user",
  ]);
  assert.equal(adapter.requests[1]?.messages.at(-1)?.content, "pending user message");
});

function zeroUsage(): ModelResult["usage"] {
  return { inputTokens: 0, outputTokens: 0 };
}
