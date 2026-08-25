/** Normalized keyboard identities used by input adapters. */

export type KeyId =
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "page_up"
  | "page_down"
  | "ctrl_c"
  | "ctrl_d"
  | "ctrl_l"
  | "character";

export interface KeyInput {
  readonly id: KeyId;
  readonly text: string | null;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type TuiInputEvent =
  | { readonly type: "key"; readonly key: KeyInput }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string };

export function makeKeyInput(
  id: KeyId,
  options: Partial<Omit<KeyInput, "id">> = {},
): KeyInput {
  return {
    id,
    text: options.text ?? null,
    ctrl: options.ctrl ?? false,
    alt: options.alt ?? false,
    shift: options.shift ?? false,
  };
}
