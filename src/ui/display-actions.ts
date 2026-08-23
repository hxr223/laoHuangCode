/** Presentation instructions emitted by runtime projections. */

export type DisplayAction =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "error"; readonly text: string }
  | { readonly type: "clear" }
  | { readonly type: "exit" };

export function makeTextDisplayAction(text: string): DisplayAction {
  return { type: "text", text };
}

export function makeStatusDisplayAction(text: string): DisplayAction {
  return { type: "status", text };
}

export function makeErrorDisplayAction(text: string): DisplayAction {
  return { type: "error", text };
}
