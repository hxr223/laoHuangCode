import type {
  HelpTranscriptBlock,
  NoticeTranscriptBlock,
  ProviderDetailTranscriptBlock,
  ProviderListTranscriptBlock,
  QueueStatusTranscriptBlock,
  TerminalUI,
} from "@laohuang/tui";
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

export class TerminalCommandPresenter implements CommandPresenter {
  readonly #ui: TerminalUI;

  constructor(ui: TerminalUI) {
    this.#ui = ui;
  }

  notice(message: NoticePresentation): void {
    const block: NoticeTranscriptBlock = {
      kind: "notice",
      key: this.#ui.newBlockId(),
      text: message.text,
      tone: message.tone,
      mutable: false,
    };
    this.#ui.appendTranscript(block);
  }

  help(view: HelpPresentation): void {
    const block: HelpTranscriptBlock = {
      kind: "help",
      key: this.#ui.newBlockId(),
      commands: view.commands,
      mutable: false,
    };
    this.#ui.appendTranscript(block);
  }

  providers(view: ProviderListPresentation): void {
    const block: ProviderListTranscriptBlock = {
      kind: "provider_list",
      key: this.#ui.newBlockId(),
      providers: view.providers,
      mutable: false,
    };
    this.#ui.appendTranscript(block);
  }

  providerDetail(view: ProviderDetailPresentation): void {
    const block: ProviderDetailTranscriptBlock = {
      kind: "provider_detail",
      key: this.#ui.newBlockId(),
      provider: view.provider,
      mutable: false,
    };
    this.#ui.appendTranscript(block);
  }

  queue(view: QueuePresentation): void {
    const block: QueueStatusTranscriptBlock = {
      kind: "queue_status",
      key: this.#ui.newBlockId(),
      queue: view.queue,
      mutable: false,
    };
    this.#ui.appendTranscript(block);
  }

  select(request: SelectionPresentation): Promise<string | null> {
    return this.#ui.select(request);
  }

  prompt(request: PromptPresentation): Promise<string | null> {
    return this.#ui.prompt(request);
  }
}
