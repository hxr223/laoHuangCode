import type {
  HelpCommandViewModel,
  NoticeTone,
  PromptRequest,
  ProviderDetailViewModel,
  ProviderSummaryViewModel,
  QueueStatusViewModel,
  SelectionRequest,
} from "@laohuang/tui";

export interface NoticePresentation {
  readonly text: string;
  readonly tone: NoticeTone;
}

export interface HelpPresentation {
  readonly commands: readonly HelpCommandViewModel[];
}

export interface ProviderListPresentation {
  readonly providers: readonly ProviderSummaryViewModel[];
}

export interface ProviderDetailPresentation {
  readonly provider: ProviderDetailViewModel;
}

export interface QueuePresentation {
  readonly queue: QueueStatusViewModel;
}

export type SelectionPresentation = SelectionRequest;
export type PromptPresentation = PromptRequest;

export interface CommandPresenter {
  notice(message: NoticePresentation): void;
  help(view: HelpPresentation): void;
  providers(view: ProviderListPresentation): void;
  providerDetail(view: ProviderDetailPresentation): void;
  queue(view: QueuePresentation): void;
  select(request: SelectionPresentation): Promise<string | null>;
  prompt(request: PromptPresentation): Promise<string | null>;
}
