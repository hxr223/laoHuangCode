import test from "node:test";
import assert from "node:assert/strict";

import { ModelRuntime } from "@laohuang/llm";
import { createPiAiAdapter } from "@laohuang/llm-pi-ai";

// Opt in with:
// DEEPSEEK_API_KEY=... npm run test:e2e:pi-ai
const enabled = process.env["LAOHUANG_RUN_PROVIDER_E2E"] === "1";
const apiKey = process.env["DEEPSEEK_API_KEY"];

test(
  "deepseek native tool call continues with a provider-neutral tool result",
  { skip: enabled ? false : "set LAOHUANG_RUN_PROVIDER_E2E=1 to run provider e2e" },
  async () => {
    assert.ok(apiKey, "DEEPSEEK_API_KEY is required for provider e2e");
    const adapter = createPiAiAdapter({
      enabledProviders: ["deepseek"],
      resolveApiKey: async () => apiKey,
    });
    const runtime = new ModelRuntime(adapter);
    const first = await runtime.complete({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: "Use the supplied tool. Do not answer from memory.",
        },
        { role: "user", content: "Call read_fixture for fixture.txt." },
      ],
      tools: [{
        name: "read_fixture",
        description: "Read one named fixture",
        parameters: {
          type: "object",
          properties: { path: { type: "string", const: "fixture.txt" } },
          required: ["path"],
          additionalProperties: false,
        },
        promptGuidelines: [],
      }],
      toolChoice: "auto",
    });

    const toolCalls = first.message.content.filter((block) => block.type === "tool-call");
    assert.equal(toolCalls.length, 1);
    const call = toolCalls[0]!.call;
    assert.equal(call.name, "read_fixture");

    const second = await runtime.complete({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: "Use the supplied tool. Do not answer from memory.",
        },
        { role: "user", content: "Call read_fixture for fixture.txt." },
        first.message,
        {
          role: "tool-result",
          toolCallId: call.id,
          toolName: call.name,
          content: "fixture-value-7429",
          isError: false,
        },
      ],
      tools: [],
      toolChoice: "none",
    });

    const text = second.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    assert.match(text, /fixture-value-7429/);
    assert.doesNotMatch(text.trim(), dsmlEnvelopePattern());
  },
);

function dsmlEnvelopePattern(): RegExp {
  const tag = `tool_${"calls"}`;
  return new RegExp(
    `^<｜｜DSML｜｜${tag}>\\s*<｜｜DSML｜｜invoke\\b[\\s\\S]*` +
      `<\\/｜｜DSML｜｜invoke>\\s*<\\/｜｜DSML｜｜${tag}>$`,
  );
}
