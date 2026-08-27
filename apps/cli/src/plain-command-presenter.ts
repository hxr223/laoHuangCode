import type {
  CommandPresenter,
  HelpPresentation,
  NoticePresentation,
  PromptPresentation,
  ProviderDetailPresentation,
  ProviderListPresentation,
  QueuePresentation,
  SelectionPresentation,
} from "./command-presentation.ts";

export interface PlainCommandPresenterOptions {
  readonly output: (value: string) => void;
  readonly input: (prompt: string) => Promise<string>;
  readonly secretInput: (prompt: string) => Promise<string>;
}

export class PlainCommandPresenter implements CommandPresenter {
  readonly #output: (value: string) => void;
  readonly #input: (prompt: string) => Promise<string>;
  readonly #secretInput: (prompt: string) => Promise<string>;

  constructor(options: PlainCommandPresenterOptions) {
    this.#output = options.output;
    this.#input = options.input;
    this.#secretInput = options.secretInput;
  }

  notice(message: NoticePresentation): void {
    this.#output(message.text);
  }

  help(view: HelpPresentation): void {
    this.#output("Commands:");
    for (const command of view.commands) {
      this.#output(`  ${command.usage}  ${command.description}`);
    }
  }

  providers(view: ProviderListPresentation): void {
    this.#output("Providers:");
    for (const provider of view.providers) {
      this.#output(providerLine(provider));
    }
  }

  providerDetail(view: ProviderDetailPresentation): void {
    const { provider } = view;
    this.#output(`Provider: ${provider.name} (${provider.id})`);
    this.#output(`  ${providerLine(provider).trim()}`);
    this.#output(`  ${provider.dynamicModels ? "Dynamic" : "Static"} models: ${provider.modelCount}`);
  }

  queue(view: QueuePresentation): void {
    const { queue } = view;
    this.#output("Queue:");
    this.#output(`  Pending: ${queue.pending} (${queue.pendingTokens} est. tokens)`);
    this.#output(`  Held: ${queue.held} (${queue.heldTokens} est. tokens)`);
    this.#output(`  Dead letters: ${queue.deadLetters}`);
  }

  async select(request: SelectionPresentation): Promise<string | null> {
    this.#output(request.title);
    request.items.forEach((item, index) => {
      const description = item.description === undefined ? "" : ` - ${item.description}`;
      this.#output(`  ${index + 1}. ${item.label}${description}`);
    });
    const answer = (await this.#input("Select option: ")).trim();
    const choice = Number(answer);
    return Number.isInteger(choice) ? request.items[choice - 1]?.value ?? null : null;
  }

  prompt(request: PromptPresentation): Promise<string | null> {
    if (request.kind === "secret") {
      return this.#secretInput(request.message);
    }
    if (request.kind === "text") {
      return this.#input(request.message);
    }
    return this.select({
      id: request.id,
      title: request.message,
      items: request.items,
    });
  }
}

function providerLine(provider: ProviderListPresentation["providers"][number]): string {
  const states = [
    provider.available ? "available" : "unavailable",
    provider.configured ? "configured" : "unconfigured",
    provider.verified ? "verified" : "unverified",
  ];
  const source = provider.source === null ? "" : `, ${provider.source}`;
  return `  ${provider.name} (${provider.id}): ${states.join(", ")}${source}`;
}
