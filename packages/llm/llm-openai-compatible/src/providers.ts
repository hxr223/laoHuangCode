/** Built-in model provider presets. */

export interface Provider {
  readonly name: string;
  readonly defaultModel: string | null;
  readonly baseUrl: string | null;
  readonly suggestedModels: readonly string[];
}

const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    name: "deepseek",
    defaultModel: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    suggestedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  openai: {
    name: "openai",
    defaultModel: null,
    baseUrl: null,
    suggestedModels: [],
  },
};

export function getProvider(name: string): Provider {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}`);
  }
  return provider;
}

export function providerNames(): string[] {
  return Object.keys(PROVIDERS).sort();
}
