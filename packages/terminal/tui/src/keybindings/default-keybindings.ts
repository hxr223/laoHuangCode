import type { Keybinding } from "./keybindings.ts";

export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { context: "terminal", key: "ctrl+o", action: "toggle_tool_output" },
  { context: "terminal", key: "ctrl+l", action: "select_model" },
  { context: "terminal", key: "ctrl+t", action: "toggle_thinking" },
  { context: "editor", key: "alt+enter", action: "submit_follow_up" },
  { context: "editor", key: "escape", action: "dismiss" },
  { context: "editor", key: "ctrl+c", action: "cancel" },
];
