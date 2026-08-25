import assert from "node:assert/strict";
import { test } from "node:test";

// NOTE: Node 22 type stripping cannot resolve ".js" specifiers to ".ts"
// sources, so test files import the ".ts" path directly (tsc only covers src/).
import {
  createClient,
  type ClientConnectionSettings,
} from "@laohuang/llm-openai-compatible";

test("openai-compatible client receives resolved connection settings", () => {
  const calls: ClientConnectionSettings[] = [];

  const clientFactory = (settings: ClientConnectionSettings) => {
    calls.push(settings);
    return { options: settings };
  };

  const config = {
    apiKey: "secret",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    provider: "deepseek",
  };

  const client = createClient(config, { clientFactory });

  assert.equal(client.options.apiKey, "secret");
  assert.equal(client.options.baseURL, "https://api.deepseek.com");
  assert.equal(calls.length, 1);
});

test("createClient requires an API key", () => {
  assert.throws(
    () => createClient({ model: "deepseek-v4-flash", provider: "deepseek" }),
    /API key is required/,
  );
});

test("baseURL is omitted when the config has no base URL", () => {
  const calls: ClientConnectionSettings[] = [];

  createClient(
    { apiKey: "secret", model: "gpt-4o", provider: "openai" },
    {
      clientFactory: (settings) => {
        calls.push(settings);
        return settings;
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { apiKey: "secret" });
  assert.equal(Object.hasOwn(calls[0]!, "baseURL"), false);
});
