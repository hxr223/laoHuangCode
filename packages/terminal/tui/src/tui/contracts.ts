import type {
  EditorEffect,
  InputAction,
} from "./editor.ts";

export interface CompletionItemLike {
  readonly value: string;
  readonly description: string;
  readonly start: number;
}

export interface EditorRenderResult {
  readonly lines: string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

/** The editor surface the interactive loop renders and drives. */
export interface EditorLike {
  text: string;
  cursor: number;
  historyIndex: number | null;
  readonly completions: readonly CompletionItemLike[];
  selectedCompletion: number | null;
  apply(action: InputAction, options: { runtimeActive: boolean }): EditorEffect;
  setCompletions(values: readonly CompletionItemLike[]): void;
  renderLines(
    width: number,
    options: {
      prompt?: string;
      mask?: boolean;
      styles?: {
        readonly prompt?: (text: string) => string;
        readonly text?: (text: string) => string;
      };
    },
  ): EditorRenderResult;
}

/** Hooks the input decoder uses to negotiate terminal keyboard modes. */
export interface InputDecoderHooks {
  enableModifyOtherKeys(): void;
  disableModifyOtherKeys(): void;
}

/** Bytes-to-actions input pipeline used by the interactive loop. */
export interface InputDecoderLike {
  kittyProtocolActive: boolean;
  feed(data: Uint8Array): InputAction[];
  flush(): InputAction[];
  clear(): void;
}

export type EditorFactory = () => EditorLike;
export type InputDecoderFactory = (hooks: InputDecoderHooks) => InputDecoderLike;
