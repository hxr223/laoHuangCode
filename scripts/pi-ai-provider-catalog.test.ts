import assert from "node:assert/strict";
import test from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { eligibleProviderIds } from "../packages/llm/llm-pi-ai/src/index.ts";

const EXCLUDED = new Set(["amazon-bedrock", "google-vertex"]);
const EXPECTED = [
  "ant-ling", "anthropic", "azure-openai-responses", "cerebras",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks",
  "github-copilot", "google", "groq", "huggingface", "kimi-coding",
  "minimax", "minimax-cn", "mistral", "moonshotai", "moonshotai-cn",
  "nvidia", "openai", "opencode", "opencode-go", "openrouter",
  "qwen-token-plan", "qwen-token-plan-cn", "radius", "together",
  "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai", "zai-coding-cn",
];

test("pi-ai 0.83 api-key provider snapshot matches the product contract", () => {
  const models = builtinModels();
  assert.deepEqual(eligibleProviderIds(models, EXCLUDED), EXPECTED);
  assert.equal(EXPECTED.length, 35);
  assert.ok(!EXPECTED.includes("openai-codex"));
});

test("eligible static providers expose only integrated pi-ai API families", () => {
  const models = builtinModels();
  const allowedApis = new Set([
    "anthropic-messages",
    "azure-openai-responses",
    "google-generative-ai",
    "mistral-conversations",
    "openai-completions",
    "openai-responses",
  ]);
  for (const providerId of EXPECTED.filter((id) => id !== "radius")) {
    const providerModels = models.getModels(providerId);
    assert.ok(providerModels.length > 0, `${providerId} has no static models`);
    for (const model of providerModels) {
      assert.ok(allowedApis.has(model.api), `${providerId}/${model.id}: ${model.api}`);
    }
  }
});
