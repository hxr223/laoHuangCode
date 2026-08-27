import test from "node:test";
import assert from "node:assert/strict";

import type { ModelCatalog, ModelInfo, ModelProviderInfo } from "@laohuang/llm";
import {
  filterModels,
  ModelSelector,
} from "../apps/cli/src/model-selection.ts";
import type { ProviderAuthController } from "../apps/cli/src/provider-auth.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

const providers: readonly ModelProviderInfo[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    authName: "DeepSeek API key",
    dynamicModels: false,
    verified: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    authName: "OpenAI API key",
    dynamicModels: false,
    verified: false,
  },
];

const models: readonly ModelInfo[] = [
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash"),
  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro"),
  model("openai", "gpt-a", "GPT A"),
  model("openai", "gpt-z", "GPT Z"),
];

function model(provider: string, id: string, name: string): ModelInfo {
  return {
    provider,
    id,
    name,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

class MemoryCatalog implements ModelCatalog {
  readonly refreshCalls: string[] = [];

  listProviders(): readonly ModelProviderInfo[] {
    return providers;
  }

  getProvider(provider: string): ModelProviderInfo | undefined {
    return providers.find((item) => item.id === provider);
  }

  listModels(provider: string): readonly ModelInfo[] {
    return models.filter((item) => item.provider === provider);
  }

  async listAvailableModels(provider: string): Promise<readonly ModelInfo[]> {
    return this.listModels(provider);
  }

  getModel(provider: string, id: string): ModelInfo | undefined {
    return this.listModels(provider).find((item) => item.id === id);
  }

  async refresh(provider: string): Promise<void> {
    this.refreshCalls.push(provider);
  }
}

class MemoryAuth implements Pick<ProviderAuthController, "ensureConfigured"> {
  readonly calls: Array<{ provider: string; promptIfMissing: boolean }> = [];
  configured = new Set(["deepseek", "openai"]);

  async ensureConfigured(
    provider: string,
    options: { promptIfMissing: boolean },
  ): Promise<boolean> {
    this.calls.push({ provider, promptIfMissing: options.promptIfMissing });
    return this.configured.has(provider);
  }
}

function fail(reason: string): (prompt: string) => Promise<string> {
  return async () => {
    throw new Error(reason);
  };
}

test("deepseek provider and model are selected in the terminal", async () => {
  const catalog = new MemoryCatalog();
  const auth = new MemoryAuth();
  const prompts: string[] = [];
  const outputs: string[] = [];
  const selector = new ModelSelector({
    catalog,
    providerAuth: auth,
    input: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? "v4" : "2";
    },
    output: (message) => {
      outputs.push(message);
    },
  });

  const selection = await selector.select({ providerName: "deepseek" });

  assert.ok(selection);
  assert.equal(selection.config.provider, "deepseek");
  assert.equal(selection.config.model, "deepseek-v4-pro");
  assert.equal("apiKey" in selection.config, false);
  assert.deepEqual(auth.calls, [
    { provider: "deepseek", promptIfMissing: true },
  ]);
  assert.deepEqual(catalog.refreshCalls, ["deepseek"]);
  assert.ok(outputs.some((output) => output.includes("deepseek-v4-pro")));
});

test("model selection retains its command presentation port", () => {
  const presenter = new RecordingPresenter();
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: new MemoryAuth(),
    input: async () => "",
    output: () => {},
    presenter,
  });

  assert.equal(selector.presenter, presenter);
});

test("user can choose a provider before choosing the model", async () => {
  const auth = new MemoryAuth();
  const answers = ["1", "v4", "1"];
  const outputs: string[] = [];
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: auth,
    input: async () => {
      const answer = answers.shift();
      assert.ok(answer !== undefined, "unexpected extra prompt");
      return answer;
    },
    output: (message) => {
      outputs.push(message);
    },
  });

  const selection = await selector.select();

  assert.ok(selection);
  assert.equal(selection.config.provider, "deepseek");
  assert.ok(outputs.some((output) => output.includes("DeepSeek")));
  assert.ok(outputs.some((output) => output.includes("OpenAI")));
});

test("session model selection requires a prior login", async () => {
  const auth = new MemoryAuth();
  auth.configured.clear();
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: auth,
    input: fail("no model input expected"),
    output: () => {},
  });

  const selection = await selector.select({
    providerName: "deepseek",
    promptForMissingKey: false,
  });

  assert.equal(selection, null);
  assert.deepEqual(auth.calls, [
    { provider: "deepseek", promptIfMissing: false },
  ]);
});

test("prompt functions are awaited like the terminal UI's async prompts", async () => {
  const gates: Array<() => void> = [];
  const answers = ["v4", "1"];
  const deferredInput = async (): Promise<string> => {
    await new Promise<void>((resolve) => {
      gates.push(resolve);
    });
    const answer = answers.shift();
    assert.ok(answer !== undefined, "unexpected extra prompt");
    return answer;
  };
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: new MemoryAuth(),
    input: () => deferredInput(),
    output: () => {},
  });

  const pending = selector.select({ providerName: "deepseek" });
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  for (let index = 0; index < 10 && gates.length === 0; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  assert.equal(settled, false);
  assert.equal(gates.length, 1);

  gates.shift()!();
  for (let index = 0; index < 10 && gates.length === 0; index += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  assert.equal(gates.length, 1);
  gates.shift()!();

  const selection = await pending;
  assert.ok(selection);
  assert.equal(selection.config.model, "deepseek-v4-flash");
});

test("model search ranks exact ids and limits output", () => {
  const searched = Array.from({ length: 30 }, (_, index) =>
    model(
      "openrouter",
      index === 29 ? "target-model" : `model-${String(index).padStart(2, "0")}`,
      index === 29 ? "Target Model" : `Model ${index}`,
    ),
  );

  assert.deepEqual(filterModels(searched, "target-model", 20).map((m) => m.id), [
    "target-model",
  ]);
  assert.equal(filterModels(searched, "model", 20).length, 20);
});

test("manual model routes must exist in the provider catalog", async () => {
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: new MemoryAuth(),
    input: async () => "",
    output: () => {},
  });
  await assert.rejects(
    selector.select({ providerName: "deepseek", modelName: "missing-model" }),
    /Unknown model: deepseek\/missing-model/,
  );
});
