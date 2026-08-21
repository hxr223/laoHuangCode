import assert from "node:assert/strict";
import { test } from "node:test";

// NOTE: Node 22 type stripping cannot resolve ".js" specifiers to ".ts"
// sources, so test files import the ".ts" path directly (tsc only covers src/).
import { getProvider, providerNames } from "../src/providers.ts";

test("deepseek profile has working agent defaults", () => {
  const provider = getProvider("deepseek");

  assert.equal(provider.defaultModel, "deepseek-v4-flash");
  assert.equal(provider.baseUrl, "https://api.deepseek.com");
  assert.deepEqual(provider.suggestedModels, [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
  ]);
});

test("supported provider names are available for configuration", () => {
  assert.deepEqual(providerNames(), ["deepseek", "openai"]);
  assert.equal(getProvider("openai").defaultModel, null);
  assert.equal(getProvider("openai").baseUrl, null);
  assert.deepEqual(getProvider("openai").suggestedModels, []);

  assert.throws(() => getProvider("custom"), /Unknown provider/);
});
