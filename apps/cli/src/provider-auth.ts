import type {
  ApiKeySetupInteraction,
  ApiKeySetupPrompt,
  ModelAuthService,
  ModelAuthStatus,
} from "@laohuang/llm";
import type { CommandPresenter } from "./command-presentation.ts";
import type { InputFn, OutputFn } from "./model-selection.ts";

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
  readonly input: InputFn;
  readonly secretInput: InputFn;
  readonly output?: OutputFn | undefined;
  readonly presenter?: CommandPresenter | undefined;
}

export class ProviderAuthController {
  readonly #auth: ModelAuthService;
  readonly #input: InputFn;
  readonly #secretInput: InputFn;
  readonly #output: OutputFn;
  #presenter: CommandPresenter | null;

  constructor(options: ProviderAuthControllerOptions) {
    this.#auth = options.auth;
    this.#input = options.input;
    this.#secretInput = options.secretInput;
    this.#output = options.output ?? ((message) => console.log(message));
    this.#presenter = options.presenter ?? null;
  }

  get presenter(): CommandPresenter | null {
    return this.#presenter;
  }

  setPresenter(presenter: CommandPresenter): void {
    this.#presenter = presenter;
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
      this.#output(
        `No credentials configured for ${provider}. Run /login ${provider} first.`,
      );
      return false;
    }
    return this.login(provider);
  }

  async login(provider: string): Promise<boolean> {
    try {
      const status = await this.#auth.loginApiKey(
        provider,
        this.#interaction(),
      );
      return status.configured;
    } catch (error) {
      if (isPromptCancellation(error)) {
        this.#output("Login cancelled; credentials were not changed.");
      } else {
        this.#output(`Login failed for ${provider}: ${errorMessage(error)}`);
      }
      return false;
    }
  }

  logout(provider: string): Promise<void> {
    return this.#auth.logout(provider);
  }

  #interaction(): ApiKeySetupInteraction {
    return {
      prompt: (prompt) => this.#prompt(prompt),
      notify: (message) => {
        this.#output(message);
      },
    };
  }

  async #prompt(prompt: ApiKeySetupPrompt): Promise<string> {
    if (prompt.type === "secret") {
      const answer = (await this.#secretInput(prompt.message)).trim();
      if (answer.length === 0) {
        throw new ProviderLoginCancelledError("empty secret");
      }
      return answer;
    }
    if (prompt.type === "text") {
      return (await this.#input(prompt.message)).trim();
    }

    this.#output(prompt.message);
    prompt.options.forEach((option, index) => {
      const description =
        option.description === undefined ? "" : ` - ${option.description}`;
      this.#output(`  ${index + 1}. ${option.label}${description}`);
    });
    const raw = (await this.#input("Select option: ")).trim();
    const choice = Number(raw);
    const selected = Number.isInteger(choice)
      ? prompt.options[choice - 1]
      : undefined;
    if (selected === undefined) {
      throw new ProviderLoginCancelledError("invalid selection");
    }
    return selected.id;
  }
}

class ProviderLoginCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderLoginCancelledError";
  }
}

function isPromptCancellation(error: unknown): boolean {
  if (error instanceof ProviderLoginCancelledError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "PromptCancelledError" ||
    error.name === "PromptEofError" ||
    error.name === "EOFError"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
