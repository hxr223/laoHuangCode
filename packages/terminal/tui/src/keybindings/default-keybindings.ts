import type { Keybinding } from "./keybindings.ts";

export const DEFAULT_KEYBINDINGS: readonly Keybinding[] = [
  { context: "editor", key: process.platform === "win32" ? "alt+v" : "ctrl+v", action: "paste_clipboard" },
  { context: "terminal", key: "ctrl+o", action: "toggle_tool_output" },
  { context: "terminal", key: "ctrl+l", action: "select_model" },
  { context: "terminal", key: "ctrl+t", action: "toggle_thinking" },
  { context: "editor", key: "ctrl+u", action: "delete_to_line_start" },
  { context: "editor", key: "ctrl+s", action: "steer_now" },
  { context: "editor", key: "alt+enter", action: "submit_follow_up" },
  { context: "editor", key: "escape", action: "dismiss" },
  { context: "editor", key: "ctrl+c", action: "cancel" },
];
