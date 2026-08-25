import test from "node:test";
import assert from "node:assert/strict";

import {
  ModelError,
  ModelStreamError,
  classifyModelError,
  modelErrorKind,
  portableModelMessage,
  type AssistantModelMessage,
  type ModelMessage,
} from "@laohuang/llm";

function statusError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

test("portableModelMessage strips only assistant replay state", () => {
  const assistant: AssistantModelMessage = {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content: [
      { type: "reasoning", text: "inspect first" },
      {
        type: "tool-call",
        call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
      },
    ],
    replay: { adapter: "pi-ai", version: 1, state: { responseId: "r1" } },
  };

  assert.deepEqual(portableModelMessage(assistant), {
    role: "assistant",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content: assistant.content,
  });
});

test("portableModelMessage preserves visible non-assistant messages", () => {
  const messages: readonly ModelMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
    {
      role: "tool-result",
      toolCallId: "call-1",
      toolName: "read",
      content: "contents",
      isError: false,
    },
  ];

  assert.deepEqual(messages.map(portableModelMessage), messages);
});

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
  assert.equal(
    classifyModelError(
      new ModelStreamError("wrapped", { cause: statusError(401, "bad key") }),
    ),
    "authentication",
  );
});

test("ModelError exposes protocol failures as a stable taxonomy kind", () => {
  const error = new ModelError("textual tool protocol leaked", {
    kind: "protocol",
    hadDelta: true,
  });

  assert.equal(error.kind, "protocol");
  assert.equal(error.hadDelta, true);
  assert.equal(modelErrorKind(error), "protocol");
});
