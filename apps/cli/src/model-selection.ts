/** Provider-neutral model catalog and exact-selection service. */

import type { ModelCatalog, ModelInfo, ModelProviderInfo } from "@laohuang/llm";
import type {
  AuthPromptHandler,
  ProviderAuthController,
} from "./provider-auth.ts";

/**
 * Minimal structural view of the runtime configuration produced here.
 * The full `Config` type is owned by config.ts.
 */
export interface SelectionConfig {
  readonly model: string;
  readonly baseUrl: string | null;
  readonly provider: string;
}

export type InputFn = (prompt: string) => Promise<string>;
export type OutputFn = (message: string) => void;

export interface ModelSelection {
  readonly config: SelectionConfig;
}

export interface ModelSelectorOptions {
  readonly catalog: ModelCatalog;
  readonly providerAuth: Pick<ProviderAuthController, "ensureConfigured">;
}

/** Build a runtime model selection without exposing API keys. */
export class ModelSelector {
  readonly #catalog: ModelCatalog;
  readonly #providerAuth: Pick<ProviderAuthController, "ensureConfigured">;

  constructor(options: ModelSelectorOptions) {
    this.#catalog = options.catalog;
    this.#providerAuth = options.providerAuth;
  }

  listProviders(): readonly ModelProviderInfo[] {
    return this.#catalog.listProviders();
  }

  async listModels(provider: string, query: string): Promise<readonly ModelInfo[]> {
    await this.#catalog.refresh(provider);
    return filterModels(
      await this.#catalog.listAvailableModels(provider),
      query,
      20,
    );
  }

  async selectExact(options: {
    readonly providerName: string;
    readonly modelName: string;
    readonly promptForMissingKey: boolean;
    readonly authPrompts?: AuthPromptHandler;
  }): Promise<ModelSelection | null> {
    const provider = this.#catalog.getProvider(options.providerName);
    if (provider === undefined) {
      throw new Error(`Unknown provider: ${options.providerName}`);
    }
    const configured = await this.#providerAuth.ensureConfigured(
      options.providerName,
      {
        promptIfMissing: options.promptForMissingKey,
        prompts: options.authPrompts,
      },
    );
    if (!configured) {
      return null;
    }
    await this.#catalog.refresh(options.providerName);
    const available = await this.#catalog.listAvailableModels(options.providerName);
    const selected = available.find((model) => model.id === options.modelName)
      ?? this.#catalog.getModel(options.providerName, options.modelName);
    if (selected === undefined) {
      throw new Error(`Unknown model: ${options.providerName}/${options.modelName}`);
    }
    return {
      config: {
        provider: options.providerName,
        model: selected.id,
        baseUrl: null,
      },
    };
  }
}

export function filterModels(
  models: readonly ModelInfo[],
  query: string,
  limit = 20,
): readonly ModelInfo[] {
  const normalized = query.toLowerCase().trim();
  const terms = normalized.split(/\s+/).filter((term) => term.length > 0);
  const matched = models.filter((model) => {
    if (terms.length === 0) {
      return true;
    }
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();
    return terms.every((term) => id.includes(term) || name.includes(term));
  });
  matched.sort((left, right) => {
    const leftId = left.id.toLowerCase();
    const rightId = right.id.toLowerCase();
    const leftExact = leftId === normalized;
    const rightExact = rightId === normalized;
    if (leftExact !== rightExact) {
      return leftExact ? -1 : 1;
    }
    const leftPrefix = normalized.length > 0 && leftId.startsWith(normalized);
    const rightPrefix = normalized.length > 0 && rightId.startsWith(normalized);
    if (leftPrefix !== rightPrefix) {
      return leftPrefix ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
  return matched.slice(0, limit);
}
