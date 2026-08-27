import type {
  CommandPresenter,
  HelpPresentation,
  NoticePresentation,
  PromptPresentation,
  ProviderDetailPresentation,
  ProviderListPresentation,
  QueuePresentation,
  SelectionPresentation,
} from "../../apps/cli/src/command-presentation.ts";

export class RecordingPresenter implements CommandPresenter {
  readonly notices: NoticePresentation[] = [];
  readonly helpViews: HelpPresentation[] = [];
  readonly providerViews: ProviderListPresentation[] = [];
  readonly providerDetails: ProviderDetailPresentation[] = [];
  readonly queueViews: QueuePresentation[] = [];
  readonly selections: SelectionPresentation[] = [];
  readonly promptRequests: PromptPresentation[] = [];
  readonly #selectionAnswers: string[];
  readonly #promptAnswers: string[];

  constructor(options: {
    readonly selections?: readonly string[];
    readonly prompts?: readonly string[];
  } = {}) {
    this.#selectionAnswers = [...(options.selections ?? [])];
    this.#promptAnswers = [...(options.prompts ?? [])];
  }

  notice(value: NoticePresentation): void { this.notices.push(value); }
  help(value: HelpPresentation): void { this.helpViews.push(value); }
  providers(value: ProviderListPresentation): void { this.providerViews.push(value); }
  providerDetail(value: ProviderDetailPresentation): void { this.providerDetails.push(value); }
  queue(value: QueuePresentation): void { this.queueViews.push(value); }
  async select(value: SelectionPresentation): Promise<string | null> {
    this.selections.push(value);
    return this.#selectionAnswers.shift() ?? null;
  }
  async prompt(value: PromptPresentation): Promise<string | null> {
    this.promptRequests.push(value);
    return this.#promptAnswers.shift() ?? null;
  }
}
