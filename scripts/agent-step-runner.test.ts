import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentCancelled } from "../src/agent.ts";
import type { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import type { ModelAdapter } from "@laohuang/llm";
import { StreamResult } from "@laohuang/llm";
import {
  AgentStepRunner,
  type AgentStepRunnerContext,
} from "../src/core/agent-step-runner.ts";
import { HistoryCommitter } from "../src/core/history-committer.ts";
import { GuardPolicy } from "../src/core/guard-policy.ts";
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
  readonly capabilities = {
    streaming: true,
    reasoningReplay: false,
    thinkingSettings: false,
  };
  readonly requests: Array<Array<Record<string, unknown>>> = [];
  private readonly responses: Iterator<StreamResult>;

  constructor(responses: StreamResult[]) {
    this.responses = responses[Symbol.iterator]();
  }

  runAttempt(
    request: {
      messages: Array<Record<string, unknown>>;
    },
  ): Promise<StreamResult> {
    this.requests.push(request.messages);
    const result = this.responses.next().value;
    if (result === undefined) {
      throw new Error("unexpected model request");
    }
    return Promise.resolve(result);
  }
}

function toolCallResult(callId: string): StreamResult {
  return new StreamResult({
    requestId: "request-1",
    content: null,
    reasoningContent: null,
    toolCalls: [
      {
        id: callId,
        type: "function",
        function: { name: "read", arguments: '{"path":"answer.txt"}' },
      },
    ],
    finishReason: "tool_calls",
  });
}

function finalResult(content: string): StreamResult {
  return new StreamResult({
    requestId: "request-final",
    content,
    reasoningContent: null,
    toolCalls: [],
    finishReason: "stop",
  });
}

function createRunner(options: {
  messages: Array<Record<string, unknown>>;
  adapter: ModelAdapter;
  context?: AgentStepRunnerContext | null;
  executeTool?: () => Promise<ToolResult>;
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
    provider: null,
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
    guardPolicy: new GuardPolicy({
      maxTotalTokens: 100_000,
      maxElapsedSeconds: 300,
      repeatedToolCallLimit: 3,
    }),
    userInput: "first user message",
    context,
    cancelToken: token,
    requestId: null,
    isRequestActive: () => true,
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
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "system" }];
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
  assert.deepEqual(adapter.requests[0]?.map((message) => message["role"]), [
    "system",
    "user",
  ]);
});

test("commits the assistant tool call before its paired tool result", async () => {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "system" }];
  const adapter = new StubAdapter([toolCallResult("call-1"), finalResult("complete")]);
  const runner = createRunner({ messages, adapter });

  assert.equal(await runner.run(), "complete");
  assert.deepEqual(messages.map((message) => message["role"]), [
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.equal(messages[3]?.["tool_call_id"], "call-1");
});

test("rejects an unconfirmed final assistant commit after cancellation wins", async () => {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "system" }];
  const adapter = new StubAdapter([finalResult("must not commit")]);
  const context: AgentStepRunnerContext = {
    commitIfActive: () => false,
  };
  const runner = createRunner({ messages, adapter, context });

  await assert.rejects(runner.run(), AgentCancelled);
  assert.deepEqual(messages.map((message) => message["role"]), ["system", "user"]);
  assert.ok(messages.every((message) => message["content"] !== "must not commit"));
});

test("commits pending user input only after the tool-result safe point", async () => {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: "system" }];
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
  assert.deepEqual(adapter.requests[1]?.map((message) => message["role"]), [
    "system",
    "user",
    "assistant",
    "tool",
    "user",
  ]);
  assert.equal(adapter.requests[1]?.at(-1)?.["content"], "pending user message");
});
