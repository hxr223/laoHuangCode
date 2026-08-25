import test from "node:test";
import assert from "node:assert/strict";

// NOTE: Node 22 type stripping cannot resolve ".js" specifiers to ".ts"
// sources, so test files import the ".ts" path directly (tsc only covers src/).
import { createClient } from "@laohuang/llm-openai-compatible";
import {
  ModelSelector,
  type CredentialStoreLike,
  type ProviderRegistry,
} from "../src/model-selection.ts";
import { getProvider, providerNames } from "@laohuang/llm-openai-compatible";

/** Registry wired exactly as production code would wire providers.ts. */
const registry: ProviderRegistry = { get: getProvider, names: providerNames };

/** In-memory stand-in for the CredentialStore owned by credentials.ts. */
class MemoryCredentialStore implements CredentialStoreLike {
  #entries = new Map<string, string>();

  get(provider: string): string | null {
    return this.#entries.get(provider) ?? null;
  }

  set(provider: string, apiKey: string): void {
    this.#entries.set(provider, apiKey);
  }
}

function fail(reason: string): (prompt: string) => Promise<string> {
  return async () => {
    throw new Error(reason);
  };
}

test("deepseek key and model are selected in the terminal", async () => {
  const credentials = new MemoryCredentialStore();
  const prompts: string[] = [];
  const outputs: string[] = [];
  const selector = new ModelSelector({
    credentials,
    registry,
    createClient,
    input: async (prompt) => {
      prompts.push(prompt);
      return "2";
    },
    secretInput: async (prompt) => {
      prompts.push(prompt);
      return "deepseek-secret";
    },
    output: (message) => {
      outputs.push(message);
    },
    clientFactory: () => ({}),
  });

  const selection = await selector.select({ providerName: "deepseek" });

  assert.ok(selection);
  assert.equal(selection.config.provider, "deepseek");
  assert.equal(selection.config.model, "deepseek-v4-pro");
  assert.equal(credentials.get("deepseek"), "deepseek-secret");
  assert.ok(outputs.some((output) => output.includes("deepseek-v4-pro")));
  assert.ok(!outputs.join("\n").includes("deepseek-secret"));
});

test("openai models are loaded before the user selects one", async () => {
  const credentials = new MemoryCredentialStore();
  const fakeClient = {
    models: {
      list: () => [{ id: "gpt-z" }, { id: "gpt-a" }],
    },
  };
  const outputs: string[] = [];
  const selector = new ModelSelector({
    credentials,
    registry,
    createClient,
    input: async () => "2",
    secretInput: async () => "openai-secret",
    output: (message) => {
      outputs.push(message);
    },
    clientFactory: () => fakeClient,
  });

  const selection = await selector.select({ providerName: "openai" });

  assert.ok(selection);
  assert.equal(selection.config.model, "gpt-z");
  assert.ok(outputs.some((output) => output.includes("gpt-a")));
  assert.ok(outputs.some((output) => output.includes("gpt-z")));
});

test("user can choose a provider before choosing the model", async () => {
  const credentials = new MemoryCredentialStore();
  credentials.set("deepseek", "saved-secret");
  const answers = ["1", "1"];
  const outputs: string[] = [];
  const selector = new ModelSelector({
    credentials,
    registry,
    createClient,
    input: async () => {
      const answer = answers.shift();
      assert.ok(answer !== undefined, "unexpected extra prompt");
      return answer;
    },
    secretInput: fail("saved credential should be reused"),
    output: (message) => {
      outputs.push(message);
    },
    clientFactory: () => ({}),
  });

  const selection = await selector.select();

  assert.ok(selection);
  assert.equal(selection.config.provider, "deepseek");
  assert.ok(outputs.some((output) => output.includes("DeepSeek")));
  assert.ok(outputs.some((output) => output.includes("OpenAI")));
});

test("session model selection requires a prior login", async () => {
  const outputs: string[] = [];
  const selector = new ModelSelector({
    credentials: new MemoryCredentialStore(),
    registry,
    createClient,
    input: fail("no model input expected"),
    secretInput: fail("no key input expected"),
    output: (message) => {
      outputs.push(message);
    },
  });

  const selection = await selector.select({
    providerName: "deepseek",
    promptForMissingKey: false,
  });

  assert.equal(selection, null);
  assert.deepEqual(outputs, [
    "No credentials configured for deepseek. Run /login deepseek first.",
  ]);
});

test("prompt functions are awaited like the terminal UI's async prompts", async () => {
  const credentials = new MemoryCredentialStore();
  const gates: Array<() => void> = [];
  // TerminalUI.prompt resolves only after the interactive loop processes the
  // answer; model selection must wait for that instead of reading a value
  // synchronously.
  const deferredInput = async (answer: string): Promise<string> => {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    return answer;
  };
  const selector = new ModelSelector({
    credentials,
    registry,
    createClient,
    input: () => deferredInput("1"),
    secretInput: () => deferredInput("ui-secret"),
    output: () => {},
    clientFactory: () => ({}),
  });

  const pending = selector.select({ providerName: "deepseek" });
  // The secret prompt is in flight but unresolved: no selection yet.
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(gates.length, 1);

  gates.shift()!();
  // Let the selector reach the model prompt before releasing it.
  for (let index = 0; index < 10 && gates.length === 0; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  assert.equal(gates.length, 1);
  gates.shift()!();

  const selection = await pending;
  assert.ok(selection);
  assert.equal(selection.config.apiKey, "ui-secret");
  assert.equal(credentials.get("deepseek"), "ui-secret");
});
