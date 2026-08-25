/** CLI-owned provider catalog built on the neutral model adapter API. */

import type { ModelAdapter } from "@laohuang/llm";

export interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string | null;
  readonly suggestedModels: readonly string[];
}

export interface ProviderCatalog {
  names(): string[];
  get(name: string): ProviderPreset;
  listModelIds(provider: string): readonly string[];
}

const BUILTIN_PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    suggestedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    baseUrl: null,
    suggestedModels: [],
  },
};

export function getProvider(name: string): ProviderPreset {
  const provider = BUILTIN_PROVIDERS[name];
  if (provider === undefined) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

export function providerNames(): string[] {
  return Object.keys(BUILTIN_PROVIDERS).sort();
}

export class AdapterProviderCatalog implements ProviderCatalog {
  readonly #adapter: Pick<ModelAdapter, "listProviders" | "listModels">;

  constructor(adapter: Pick<ModelAdapter, "listProviders" | "listModels">) {
    this.#adapter = adapter;
  }

  names(): string[] {
    const enabled = new Set(this.#adapter.listProviders().map((provider) => provider.id));
    return providerNames().filter((name) => enabled.has(name));
  }

  get(name: string): ProviderPreset {
    const provider = getProvider(name);
    if (!this.names().includes(name)) {
      throw new Error(`Unknown provider: ${name}`);
    }
    const listed = this.#adapter.listProviders().find((item) => item.id === name);
    return {
      ...provider,
      name: listed?.name ?? provider.name,
    };
  }

  listModelIds(provider: string): readonly string[] {
    const preset = this.get(provider);
    if (preset.suggestedModels.length > 0) {
      return preset.suggestedModels;
    }
    return this.#adapter
      .listModels(provider)
      .map((model) => model.id)
      .sort();
  }
}
