/** Interactive provider and model selection. */

import type { ModelCatalog, ModelInfo } from "@laohuang/llm";
import type { ProviderAuthController } from "./provider-auth.ts";

/**
 * Minimal structural view of the runtime configuration produced here.
 * The full `Config` type is owned by config.ts.
 */
export interface SelectionConfig {
  readonly model: string;
  readonly baseUrl: string | null;
  readonly provider: string;
}

/**
 * Question functions are asynchronous: inside an interactive session they are
 * wired to `TerminalUI.prompt`/`TerminalUI.promptSecret`, which resolve only
 * after the running terminal loop processes the answer.
 */
export type InputFn = (prompt: string) => Promise<string>;
export type OutputFn = (message: string) => void;

export interface ModelSelection {
  readonly config: SelectionConfig;
}

export interface ModelSelectorOptions {
  readonly catalog: ModelCatalog;
  readonly providerAuth: Pick<ProviderAuthController, "ensureConfigured">;
  readonly input: InputFn;
  readonly output?: OutputFn | undefined;
}

export interface SelectOptions {
  readonly providerName?: string | undefined;
  readonly modelName?: string | undefined;
  readonly promptForMissingKey?: boolean | undefined;
}

/** Build a runtime model selection without exposing API keys. */
export class ModelSelector {
  readonly #catalog: ModelCatalog;
  readonly #providerAuth: Pick<ProviderAuthController, "ensureConfigured">;
  readonly #input: InputFn;
  readonly #output: OutputFn;

  constructor(options: ModelSelectorOptions) {
    this.#catalog = options.catalog;
    this.#providerAuth = options.providerAuth;
    this.#input = options.input;
    this.#output = options.output ?? ((message) => console.log(message));
  }

  async select(options: SelectOptions = {}): Promise<ModelSelection | null> {
    const promptForMissingKey = options.promptForMissingKey ?? true;

    let providerName = options.providerName;
    if (providerName === undefined) {
      providerName = (await this.#chooseProvider()) ?? undefined;
      if (providerName === undefined) {
        return null;
      }
    }
    const provider = this.#catalog.getProvider(providerName);
    if (provider === undefined) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    if (
      !(await this.#providerAuth.ensureConfigured(providerName, {
        promptIfMissing: promptForMissingKey,
      }))
    ) {
      return null;
    }

    await this.#catalog.refresh(providerName);
    const models = await this.#catalog.listAvailableModels(providerName);

    let modelName = options.modelName;

    if (modelName === undefined) {
      if (models.length === 0) {
        throw new Error(`No models available for provider: ${providerName}`);
      }
      modelName = (await this.#chooseModel(models))?.id;
      if (modelName === undefined) {
        this.#output("Model selection cancelled: model name is empty.");
        return null;
      }
    }

    const selected =
      models.find((model) => model.id === modelName) ??
      this.#catalog.getModel(providerName, modelName);
    if (selected === undefined) {
      throw new Error(`Unknown model: ${providerName}/${modelName}`);
    }

    const config: SelectionConfig = {
      model: selected.id,
      baseUrl: null,
      provider: providerName,
    };
    return { config };
  }

  async #chooseProvider(): Promise<string | null> {
    const providers = this.#catalog.listProviders();
    this.#output("Model providers:");
    providers.forEach((provider, index) => {
      const status = provider.verified ? "verified" : "unverified";
      this.#output(`  ${index + 1}. ${provider.name} (${provider.id}, ${status})`);
    });
    const answer = await this.#readInput("Select provider: ");
    if (answer === null) {
      return null;
    }
    const choice = Number(answer);
    const selected = Number.isInteger(choice)
      ? providers[choice - 1]?.id
      : undefined;
    if (selected === undefined) {
      this.#output("Model selection cancelled: invalid provider.");
      return null;
    }
    return selected;
  }

  async #chooseModel(models: readonly ModelInfo[]): Promise<ModelInfo | null> {
    for (;;) {
      const query = await this.#readInput("Search models: ");
      if (query === null) {
        return null;
      }
      const allMatches = filterModels(models, query, Number.MAX_SAFE_INTEGER);
      const matches = allMatches.slice(0, 20);
      if (matches.length === 0) {
        this.#output("No models matched. Try another search.");
        continue;
      }
      this.#output("Available models:");
      matches.forEach((model, index) => {
        this.#output(`  ${index + 1}. ${model.id} - ${model.name}`);
      });
      if (matches.length < allMatches.length) {
        this.#output(`Showing ${matches.length} of ${allMatches.length}`);
      }
      const answer = await this.#readInput("Select model: ");
      if (answer === null) {
        return null;
      }
      const choice = Number(answer);
      const selected = Number.isInteger(choice)
        ? matches[choice - 1]
        : undefined;
      if (selected !== undefined) {
        return selected;
      }
      if (answer.length > 0) {
        this.#output("Model selection cancelled: invalid choice.");
        return null;
      }
    }
  }

  async #readInput(prompt: string): Promise<string | null> {
    try {
      return (await this.#input(prompt)).trim();
    } catch {
      this.#output("Model selection cancelled.");
      return null;
    }
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
