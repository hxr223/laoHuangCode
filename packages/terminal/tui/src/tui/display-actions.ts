/** Presentation instructions emitted by runtime projections. */

export type DisplayAction =
  | { readonly type: "toggle_tool_output"; readonly expanded: boolean }
  | { readonly type: "toggle_reasoning"; readonly visible: boolean }
  | { readonly type: "clear" }
  | { readonly type: "exit" };

/** A local display preference; it is never a session or model action. */
export function makeToggleToolOutputDisplayAction(expanded: boolean): DisplayAction {
  return { type: "toggle_tool_output", expanded };
}

/** A local display preference; it is never a session or model action. */
export function makeToggleReasoningDisplayAction(visible: boolean): DisplayAction {
  return { type: "toggle_reasoning", visible };
}
