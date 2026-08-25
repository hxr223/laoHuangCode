import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import type { AssembledToolCall } from "../src/model-stream.ts";
import {
  ToolExecutionContext,
  ToolRuntime,
  type ToolExecutionContextLike,
  type ToolExecutionMode,
  type ToolRegistryLike,
  type ToolResult,
} from "../packages/core/tools/src/index.ts";
import { createTestToolRegistry } from "./test-tool-registry.ts";

function call(
  id: string,
  name: string,
  argumentsText: string,
): AssembledToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: argumentsText },
  };
}

class StubTools implements ToolRegistryLike {
  readonly definitions = [];
  readonly orderedSpecs = [];
  readonly executed: string[] = [];
  private readonly executeFn: (
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContextLike | undefined,
  ) => Promise<ToolResult> | ToolResult;
  private readonly mode: (name: string) => ToolExecutionMode | undefined;

  constructor(
    executeFn: (
      name: string,
      args: Record<string, unknown>,
      context: ToolExecutionContextLike | undefined,
    ) => Promise<ToolResult> | ToolResult,
    mode: (name: string) => ToolExecutionMode | undefined = () => undefined,
  ) {
    this.executeFn = executeFn;
    this.mode = mode;
  }

  executionMode(name: string): ToolExecutionMode | undefined {
    return this.mode(name);
  }

  execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> | ToolResult {
    this.executed.push(name);
    return this.executeFn(name, args, context);
  }
}

test("returns a paired failure for malformed tool arguments", async () => {
  const tools = new StubTools(() => ({ ok: true }));
  const runtime = new ToolRuntime(tools);

  const batch = await runtime.execute({
    toolCalls: [call("call-1", "read", "not json")],
    executionMode: "parallel",
    cancelToken: null,
  });

  assert.equal(tools.executed.length, 0);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0]?.ok, false);
  assert.match(String(batch.results[0]?.error), /Unexpected token/);
});

test("returns concurrent tool results in model call order", async () => {
  const tools = new StubTools(async (name) => {
    if (name === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { ok: true, content: name };
  });
  const runtime = new ToolRuntime(tools);

  const batch = await runtime.execute({
    toolCalls: [
      call("call-slow", "slow", "{}"),
      call("call-fast", "fast", "{}"),
    ],
    executionMode: "parallel",
    cancelToken: null,
  });

  assert.deepEqual(
    batch.results.map((toolResult) => toolResult.content),
    ["slow", "fast"],
  );
});

test("serializes a batch containing a write", async () => {
  const order: string[] = [];
  const tools = new StubTools(async (name) => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`${name}:finish`);
    return { ok: true };
  });
  const runtime = new ToolRuntime(tools);

  await runtime.execute({
    toolCalls: [
      call("call-write", "write", '{"path":"a.txt","content":"a"}'),
      call("call-read", "read", '{"path":"a.txt"}'),
    ],
    executionMode: "parallel",
    cancelToken: null,
  });

  assert.deepEqual(order, ["write:start", "write:finish", "read:start", "read:finish"]);
});

test("passes cancellation through to running bash tools", async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "laohuang-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = new CancelToken();
  const runtime = new ToolRuntime(createTestToolRegistry(directory), {
    createExecutionContext: (toolCallId, cancelToken) =>
      new ToolExecutionContext({ toolCallId, cancelToken }),
  });
  const cancel = setTimeout(() => token.cancel("stop bash"), 40);

  try {
    const batch = await runtime.execute({
      toolCalls: [
        call(
          "call-bash",
          "bash",
          '{"command":"sleep 10","description":"wait"}',
        ),
      ],
      executionMode: "parallel",
      cancelToken: token,
    });
    assert.deepEqual(batch.results[0], {
      ok: false,
      status: "cancelled",
      exit_code: -15,
      stdout: "",
      stderr: "",
      duration_ms: batch.results[0]?.duration_ms,
      truncated: false,
      error: "stop bash",
    });
  } finally {
    clearTimeout(cancel);
  }
});

test("marks tools not started after cancellation as cancelled", async () => {
  const token = new CancelToken();
  const tools = new StubTools((name) => {
    if (name === "write") {
      token.cancel("stop after write");
    }
    return { ok: true, content: name };
  });
  const runtime = new ToolRuntime(tools);

  const batch = await runtime.execute({
    toolCalls: [
      call("call-write", "write", '{"path":"a.txt","content":"a"}'),
      call("call-read", "read", '{"path":"a.txt"}'),
    ],
    executionMode: "parallel",
    cancelToken: token,
  });

  assert.deepEqual(tools.executed, ["write"]);
  assert.deepEqual(batch.results[1], {
    ok: false,
    status: "cancelled",
    error: "stop after write",
  });
});
