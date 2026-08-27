export interface HelpCommandViewModel {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

export interface ProviderSummaryViewModel {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly source: string | null;
}

export interface ProviderDetailViewModel extends ProviderSummaryViewModel {
  readonly dynamicModels: boolean;
  readonly modelCount: number;
}

export interface QueueStatusViewModel {
  readonly pending: number;
  readonly pendingTokens: number;
  readonly held: number;
  readonly heldTokens: number;
  readonly deadLetters: number;
}
