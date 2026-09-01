import type { SelectItem } from "../primitives/select-list.ts";

export interface SelectionRequest {
  readonly id: string;
  readonly title: string;
  readonly items: readonly SelectItem[];
  readonly currentValue?: string;
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly maxVisible?: number;
}

export type PromptRequest =
  | { readonly id: string; readonly kind: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly id: string; readonly kind: "secret"; readonly message: string; readonly placeholder?: string }
  | { readonly id: string; readonly kind: "select"; readonly message: string; readonly items: readonly SelectItem[] };

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
