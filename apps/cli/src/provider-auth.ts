import type {
  ApiKeySetupInteraction,
  ApiKeySetupPrompt,
  ModelAuthService,
  ModelAuthStatus,
} from "@laohuang/llm";

export interface AuthPromptHandler {
  prompt(request: {
    readonly kind: "text" | "secret" | "select";
    readonly message: string;
    readonly options?: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
    }[];
  }): Promise<string | null>;
}

export interface ProviderAuthControllerOptions {
  readonly auth: ModelAuthService;
}

export class ProviderAuthController {
  readonly #auth: ModelAuthService;

  constructor(options: ProviderAuthControllerOptions) {
    this.#auth = options.auth;
  }

  status(provider: string): Promise<ModelAuthStatus> {
    return this.#auth.status(provider);
  }

  async ensureConfigured(
    provider: string,
    options: {
      readonly promptIfMissing: boolean;
      readonly prompts?: AuthPromptHandler;
    },
  ): Promise<boolean> {
    const status = await this.status(provider);
    if (status.configured) {
      return true;
    }
    if (!options.promptIfMissing) {
      return false;
    }
    if (options.prompts === undefined) {
      throw new Error("Authentication prompt handler is required.");
    }
    const configured = await this.login(provider, options.prompts);
    return configured?.configured ?? false;
  }

  async login(
    provider: string,
    prompts: AuthPromptHandler,
  ): Promise<ModelAuthStatus | null> {
    try {
      return await this.#auth.loginApiKey(provider, this.#interaction(prompts));
    } catch (error) {
      if (error instanceof ProviderLoginCancelledError) {
        return null;
      }
      throw error;
    }
  }

  logout(provider: string): Promise<void> {
    return this.#auth.logout(provider);
  }

  #interaction(prompts: AuthPromptHandler): ApiKeySetupInteraction {
    return {
      prompt: (prompt) => this.#prompt(prompt, prompts),
      notify: () => {},
    };
  }

  async #prompt(
    prompt: ApiKeySetupPrompt,
    prompts: AuthPromptHandler,
  ): Promise<string> {
    const answer = await prompts.prompt(
      prompt.type === "select"
        ? {
            kind: prompt.type,
            message: prompt.message,
            options: prompt.options,
          }
        : {
            kind: prompt.type,
            message: prompt.message,
          },
    );
    if (answer === null) {
      throw new ProviderLoginCancelledError();
    }
    return answer;
  }
}

class ProviderLoginCancelledError extends Error {
  constructor() {
    super("Authentication prompt cancelled.");
    this.name = "ProviderLoginCancelledError";
  }
}
