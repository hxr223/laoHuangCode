import test from "node:test";
import assert from "node:assert/strict";

import { parseKey } from "../packages/terminal/tui/src/keybindings/key-parser.ts";
import { DEFAULT_KEYBINDINGS } from "../packages/terminal/tui/src/keybindings/default-keybindings.ts";
import {
  KeybindingsManager,
  type Keybinding,
} from "../packages/terminal/tui/src/keybindings/keybindings.ts";
import { hintForAction } from "../packages/terminal/tui/src/keybindings/hints.ts";

test("parses ctrl+o into a normalized key", () => {
  assert.deepEqual(parseKey("ctrl+o"), {
    id: "character",
    text: "o",
    ctrl: true,
    alt: false,
    shift: false,
  });
});

test("resolves a binding in its active context", () => {
  const manager = new KeybindingsManager([
    { context: "editor", key: "ctrl+o", action: "toggle_tool_output" },
  ]);

  assert.equal(manager.resolve(parseKey("ctrl+o"), ["editor"]), "toggle_tool_output");
  assert.equal(manager.resolve(parseKey("ctrl+o"), ["terminal"]), null);
});

test("allows the same key to be reused in different contexts", () => {
  const manager = new KeybindingsManager([
    { context: "editor", key: "escape", action: "dismiss" },
    { context: "question", key: "escape", action: "cancel" },
  ]);

  assert.equal(manager.resolve(parseKey("escape"), ["editor"]), "dismiss");
  assert.equal(manager.resolve(parseKey("escape"), ["question"]), "cancel");
});

test("reports conflicts for duplicate keys in the same context", () => {
  const bindings: readonly Keybinding[] = [
    { context: "editor", key: "ctrl+o", action: "toggle_tool_output" },
    { context: "editor", key: "ctrl+o", action: "toggle_thinking" },
  ];

  assert.deepEqual(new KeybindingsManager(bindings).conflicts(), [
    {
      context: "editor",
      key: "ctrl+o",
      actions: ["toggle_tool_output", "toggle_thinking"],
    },
  ]);
});

test("uses an empty action binding to disable a default", () => {
  const manager = new KeybindingsManager(DEFAULT_KEYBINDINGS, {
    toggle_tool_output: [],
  });

  assert.equal(manager.resolve(parseKey("ctrl+o"), ["terminal"]), null);
});

test("default session bindings expose model selection and follow-up submit", () => {
  const manager = new KeybindingsManager(DEFAULT_KEYBINDINGS);

  assert.equal(manager.resolve(parseKey("ctrl+l"), ["terminal"]), "select_model");
  assert.equal(manager.resolve(parseKey("ctrl+t"), ["terminal"]), "toggle_thinking");
  assert.equal(manager.resolve(parseKey("shift+tab"), ["terminal"]), null);
  assert.equal(manager.resolve(parseKey("ctrl+s"), ["editor"]), "steer_now");
  assert.equal(manager.resolve(parseKey("alt+enter"), ["editor"]), "submit_follow_up");
});

test("finds the primary key hint for an action", () => {
  const manager = new KeybindingsManager([
    { context: "editor", key: "ctrl+o", action: "toggle_tool_output" },
  ]);

  assert.equal(hintForAction(manager, "toggle_tool_output", ["editor"]), "Ctrl+O");
});
