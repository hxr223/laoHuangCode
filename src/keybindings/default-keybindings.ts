import type { Keybinding } from "./keybindings.ts";

export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { context: "terminal", key: "ctrl+o", action: "toggle_tool_output" },
  { context: "terminal", key: "ctrl+l", action: "clear_screen" },
  { context: "terminal", key: "ctrl+t", action: "toggle_thinking" },
  { context: "terminal", key: "shift+tab", action: "cycle_thinking" },
  { context: "editor", key: "alt+enter", action: "editor_newline" },
  { context: "editor", key: "escape", action: "dismiss" },
  { context: "editor", key: "ctrl+c", action: "cancel" },
];
