/** Interactive provider, credential, and model selection. */

// Type-only imports (erased at runtime): the concrete modules are injected
// below for testability. Production wiring passes `getProvider`/`providerNames`
// from providers.ts and `createClient` from client.ts.
import type {
  ClientConnectionSettings,
  Provider,
} from "@laohuang/llm-openai-compatible";
import type { ModelAdapter } from "@laohuang/llm";

/**
 * Minimal structural view of the runtime configuration produced here.
 * The full `Config` type is owned by config.ts.
 */
export interface SelectionConfig {
  readonly apiKey: string | null;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly provider: string;
}

/**
 * Minimal structural view of the credential store owned by credentials.ts:
 * only the two methods model selection relies on.
 */
export interface CredentialStoreLike {
  get(provider: string): string | null;
  set(provider: string, apiKey: string): void;
}

/** Structural view of the provider registry owned by providers.ts. */
export interface ProviderRegistry {
  /** Look up a preset by name; throws on unknown providers. */
  get(name: string): Provider;
  /** Sorted provider names. */
  names(): string[];
}

/**
 * Question functions are asynchronous: inside an interactive session they are
 * wired to `TerminalUI.prompt`/`TerminalUI.promptSecret`, which resolve only
 * after the running terminal loop processes the answer.
 */
export type InputFn = (prompt: string) => Promise<string>;
export type OutputFn = (message: string) => void;
export type ClientFactory = (settings: ClientConnectionSettings) => unknown;

/** Structural match for `createClient` from client.ts. */
export type CreateClientFn = (
  config: { apiKey?: string | undefined; baseUrl?: string | undefined },
  options?: { clientFactory?: ClientFactory | undefined },
) => unknown;

export type ModelAdapterFactory = (
  provider: string,
  client: unknown,
) => ModelAdapter;

export interface ModelSelection {
  readonly config: SelectionConfig;
  readonly client: unknown;
  readonly modelAdapter: ModelAdapter;
}

export interface ModelSelectorOptions {
  readonly credentials: CredentialStoreLike;
  readonly registry: ProviderRegistry;
  readonly createClient: CreateClientFn;
  readonly createModelAdapter: ModelAdapterFactory;
  readonly input: InputFn;
  readonly secretInput: InputFn;
  readonly output?: OutputFn | undefined;
  readonly clientFactory?: ClientFactory | undefined;
}

export interface SelectOptions {
  readonly providerName?: string | undefined;
  readonly modelName?: string | undefined;
  readonly promptForMissingKey?: boolean | undefined;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
};

/** Build a runtime model selection without exposing API keys. */
export class ModelSelector {
  readonly #credentials: CredentialStoreLike;
  readonly #registry: ProviderRegistry;
  readonly #createClient: CreateClientFn;
  readonly #createModelAdapter: ModelAdapterFactory;
  readonly #input: InputFn;
  readonly #secretInput: InputFn;
  readonly #output: OutputFn;
  readonly #clientFactory: ClientFactory | undefined;

  constructor(options: ModelSelectorOptions) {
    this.#credentials = options.credentials;
    this.#registry = options.registry;
    this.#createClient = options.createClient;
    this.#createModelAdapter = options.createModelAdapter;
    this.#input = options.input;
    this.#secretInput = options.secretInput;
    this.#output = options.output ?? ((message) => console.log(message));
    this.#clientFactory = options.clientFactory;
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
    const provider = this.#registry.get(providerName);

    let apiKey = this.#credentials.get(providerName);
    const newApiKey = apiKey === null;
    if (apiKey === null) {
      if (!promptForMissingKey) {
        this.#output(
          `No credentials configured for ${providerName}. ` +
            `Run /login ${providerName} first.`,
        );
        return null;
      }
      apiKey = await this.#readSecret(`Enter ${providerName} API key: `);
      if (!apiKey) {
        this.#output("Model selection cancelled: API key is empty.");
        return null;
      }
    }

    let modelName = options.modelName;
    const client = this.#createClient(
      {
        apiKey,
        baseUrl: provider.baseUrl ?? undefined,
      },
      { clientFactory: this.#clientFactory },
    );

    if (modelName === undefined) {
      let models: readonly string[] = provider.suggestedModels;
      if (models.length === 0) {
        try {
          const listed: unknown = await (
            client as { models: { list(): unknown } }
          ).models.list();
          models = [...(listed as Iterable<{ id?: unknown }>)]
            .map((model) => model?.id)
            .filter((id): id is string => typeof id === "string")
            .sort();
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "Error";
          this.#output(
            `Could not load models (${errorName}); enter a model name manually.`,
          );
          models = [];
        }
      }
      modelName =
        models.length > 0
          ? (await this.#chooseModel(models)) ?? undefined
          : (await this.#readInput("Model name: ")) || undefined;
      if (modelName === undefined) {
        this.#output("Model selection cancelled: model name is empty.");
        return null;
      }
    }

    const config: SelectionConfig = {
      apiKey,
      model: modelName,
      baseUrl: provider.baseUrl,
      provider: providerName,
    };
    if (newApiKey) {
      this.#credentials.set(providerName, apiKey);
    }
    return {
      config,
      client,
      modelAdapter: this.#createModelAdapter(providerName, client),
    };
  }

  async #chooseProvider(): Promise<string | null> {
    const names = this.#registry.names();
    this.#output("Model providers:");
    names.forEach((name, index) => {
      this.#output(`  ${index + 1}. ${PROVIDER_DISPLAY_NAMES[name] ?? name}`);
    });
    const answer = await this.#readInput("Select provider: ");
    if (answer === null) {
      return null;
    }
    const choice = Number(answer);
    const selected = Number.isInteger(choice) ? names[choice - 1] : undefined;
    if (selected === undefined) {
      this.#output("Model selection cancelled: invalid provider.");
      return null;
    }
    return selected;
  }

  async #chooseModel(models: readonly string[]): Promise<string | null> {
    this.#output("Available models:");
    models.forEach((model, index) => {
      this.#output(`  ${index + 1}. ${model}`);
    });
    this.#output("  m. Enter a model name manually");
    const answer = await this.#readInput("Select model: ");
    if (answer === null) {
      return null;
    }
    if (answer.toLowerCase() === "m") {
      const manual = await this.#readInput("Model name: ");
      return manual || null;
    }
    const choice = Number(answer);
    const selected = Number.isInteger(choice) ? models[choice - 1] : undefined;
    if (selected === undefined) {
      this.#output("Model selection cancelled: invalid choice.");
      return null;
    }
    return selected;
  }

  async #readInput(prompt: string): Promise<string | null> {
    try {
      return (await this.#input(prompt)).trim();
    } catch {
      this.#output("Model selection cancelled.");
      return null;
    }
  }

  async #readSecret(prompt: string): Promise<string | null> {
    try {
      return (await this.#secretInput(prompt)).trim();
    } catch {
      this.#output("Model selection cancelled.");
      return null;
    }
  }
}
