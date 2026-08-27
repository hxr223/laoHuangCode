import test from "node:test";
import assert from "node:assert/strict";

import type { ModelCatalog, ModelInfo, ModelProviderInfo } from "@laohuang/llm";
import {
  filterModels,
  ModelSelector,
} from "../apps/cli/src/model-selection.ts";
import type {
  AuthPromptHandler,
  ProviderAuthController,
} from "../apps/cli/src/provider-auth.ts";

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
  readonly calls: Array<{
    readonly provider: string;
    readonly promptIfMissing: boolean;
    readonly prompts: AuthPromptHandler | undefined;
  }> = [];
  configured = new Set(["deepseek", "openai"]);

  async ensureConfigured(
    provider: string,
    options: {
      readonly promptIfMissing: boolean;
      readonly prompts?: AuthPromptHandler;
    },
  ): Promise<boolean> {
    this.calls.push({
      provider,
      promptIfMissing: options.promptIfMissing,
      prompts: options.prompts,
    });
    return this.configured.has(provider);
  }
}

test("model selector exposes providers without presentation ownership", () => {
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: new MemoryAuth(),
  });

  assert.deepEqual(selector.listProviders(), providers);
});

test("model selector refreshes and filters available models", async () => {
  const catalog = new MemoryCatalog();
  const selector = new ModelSelector({ catalog, providerAuth: new MemoryAuth() });

  const available = await selector.listModels("deepseek", "pro");

  assert.deepEqual(available.map((item) => item.id), ["deepseek-v4-pro"]);
  assert.deepEqual(catalog.refreshCalls, ["deepseek"]);
});

test("exact selection returns provider-neutral runtime configuration", async () => {
  const catalog = new MemoryCatalog();
  const auth = new MemoryAuth();
  const prompts: AuthPromptHandler = { prompt: async () => "secret" };
  const selector = new ModelSelector({ catalog, providerAuth: auth });

  const selection = await selector.selectExact({
    providerName: "deepseek",
    modelName: "deepseek-v4-pro",
    promptForMissingKey: true,
    authPrompts: prompts,
  });

  assert.deepEqual(selection, {
    config: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: null,
    },
  });
  assert.equal("apiKey" in selection!.config, false);
  assert.deepEqual(auth.calls, [{
    provider: "deepseek",
    promptIfMissing: true,
    prompts,
  }]);
  assert.deepEqual(catalog.refreshCalls, ["deepseek"]);
});

test("session exact selection requires prior login without auth prompts", async () => {
  const auth = new MemoryAuth();
  auth.configured.clear();
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: auth,
  });

  const selection = await selector.selectExact({
    providerName: "deepseek",
    modelName: "deepseek-v4-flash",
    promptForMissingKey: false,
  });

  assert.equal(selection, null);
  assert.deepEqual(auth.calls, [{
    provider: "deepseek",
    promptIfMissing: false,
    prompts: undefined,
  }]);
});

test("model search ranks exact ids and limits output", () => {
  const searched = Array.from({ length: 30 }, (_, index) =>
    model(
      "openrouter",
      index === 29 ? "target-model" : `model-${String(index).padStart(2, "0")}`,
      index === 29 ? "Target Model" : `Model ${index}`,
    ),
  );

  assert.deepEqual(filterModels(searched, "target-model", 20).map((item) => item.id), [
    "target-model",
  ]);
  assert.equal(filterModels(searched, "model", 20).length, 20);
});

test("exact model routes must exist in the provider catalog", async () => {
  const selector = new ModelSelector({
    catalog: new MemoryCatalog(),
    providerAuth: new MemoryAuth(),
  });

  await assert.rejects(
    selector.selectExact({
      providerName: "deepseek",
      modelName: "missing-model",
      promptForMissingKey: false,
    }),
    /Unknown model: deepseek\/missing-model/,
  );
  await assert.rejects(
    selector.selectExact({
      providerName: "missing",
      modelName: "missing-model",
      promptForMissingKey: false,
    }),
    /Unknown provider: missing/,
  );
});
