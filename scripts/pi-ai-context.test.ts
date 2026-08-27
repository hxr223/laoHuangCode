import test from "node:test";
import assert from "node:assert/strict";

import { ModelError, type ModelRequest } from "@laohuang/llm";
import {
  toPiAssistant,
  toPiContext,
  toReplayEnvelope,
} from "../packages/llm/llm-pi-ai/src/index.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        content: [{
          type: "tool-call",
          call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
        }],
      },
      {
        role: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        content: "contents",
        isError: false,
      },
    ],
    tools: [{
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      promptGuidelines: ["Mention line ranges in final prose."],
    }],
    ...overrides,
  };
}

test("toPiContext converts neutral history, tools, and tool results", () => {
  const modelRequest = request();
  const context = toPiContext(modelRequest);

  assert.equal(context.systemPrompt, "system");
  assert.deepEqual(context.tools, [{
    name: "read",
    description: "Read a file",
    parameters: modelRequest.tools[0]!.parameters,
  }]);
  assert.equal(context.messages.at(-1)?.role, "toolResult");
  assert.deepEqual(context.messages.at(-1), {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "contents" }],
    isError: false,
    timestamp: 0,
  });
});

test("toPiContext omits tools when the request has no tools", () => {
  const context = toPiContext(request({ tools: [] }));

  assert.ok(!("tools" in context));
});

test("toPiContext rejects duplicate system messages as protocol errors", () => {
  assert.throws(
    () =>
      toPiContext(request({
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "hello" },
        ],
      })),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
});

test("replay envelopes restore same-route pi assistant metadata", () => {
  const piMessage: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    responseModel: "deepseek-v4-flash-202608",
    responseId: "response-1",
    stopReason: "toolUse",
    usage: zeroUsage(),
    timestamp: 12,
    content: [
      { type: "text", text: "visible", textSignature: "text-sig" },
      { type: "thinking", thinking: "hidden", thinkingSignature: "think-sig", redacted: true },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "a.txt" },
        thoughtSignature: "tool-sig",
      },
    ],
  };
  const replay = toReplayEnvelope(piMessage);

  const restored = toPiAssistant(
    {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      replay,
      content: [
        { type: "text", text: "visible" },
        { type: "reasoning", text: "hidden" },
        {
          type: "tool-call",
          call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
        },
      ],
    },
    { provider: "deepseek", model: "deepseek-v4-flash" },
  );

  assert.equal(restored.api, "openai-completions");
  assert.equal(restored.responseId, "response-1");
  assert.equal(restored.responseModel, "deepseek-v4-flash-202608");
  assert.equal(restored.content[0]?.type, "text");
  assert.equal(restored.content[0]?.textSignature, "text-sig");
  assert.equal(restored.content[1]?.type, "thinking");
  assert.equal(restored.content[1]?.thinkingSignature, "think-sig");
  assert.equal(restored.content[1]?.redacted, true);
  assert.equal(restored.content[2]?.type, "toolCall");
  assert.equal(restored.content[2]?.thoughtSignature, "tool-sig");
});

test("foreign or malformed replay degrades to visible provider-neutral content", () => {
  const degraded = toPiAssistant(
    {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      replay: { adapter: "pi-ai", version: 1, state: { provider: "openai" } },
      content: [
        { type: "text", text: "visible" },
        {
          type: "tool-call",
          call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
        },
      ],
    },
    { provider: "deepseek", model: "deepseek-v4-flash" },
  );

  assert.equal(degraded.provider, "deepseek");
  assert.equal(degraded.model, "deepseek-v4-flash");
  assert.equal(degraded.api, "pi-ai");
  assert.equal(degraded.responseId, undefined);
  assert.deepEqual(degraded.content, [
    { type: "text", text: "visible" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
  ]);
});

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
