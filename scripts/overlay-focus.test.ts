import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPLETION_OVERLAY,
  COMPOSER_COMPONENT,
  createModalOverlay,
  createSelectorOverlay,
} from "../src/tui/components.ts";
import { FocusManager } from "../src/tui/focus-manager.ts";
import { OverlayManager } from "../src/tui/overlay-manager.ts";
import { TerminalUI, type CommandRegistryLike } from "../src/tui/ui.ts";
import { MemoryTerminalDriver } from "../src/tui/screen.ts";

const encoder = new TextEncoder();

const exitRegistry: CommandRegistryLike = {
  complete(text) {
    return text.startsWith("/") && "/exit".startsWith(text)
      ? [{ value: "/exit", description: "Exit", start: -text.length }]
      : [];
  },
};

function createFocus(): { overlays: OverlayManager; focus: FocusManager } {
  const overlays = new OverlayManager();
  return { overlays, focus: new FocusManager(overlays, COMPOSER_COMPONENT) };
}

test("focus routes to the composer without an overlay", () => {
  const { focus } = createFocus();

  assert.equal(focus.current(), "composer");
});

test("focus routes to completion when completion is open", () => {
  const { overlays, focus } = createFocus();
  overlays.open(COMPLETION_OVERLAY);

  assert.equal(focus.current(), "completion");
});

test("selector focus takes priority over completion", () => {
  const { overlays, focus } = createFocus();
  overlays.open(COMPLETION_OVERLAY);
  overlays.open(createSelectorOverlay("command-selector"));

  assert.equal(focus.current(), "command-selector");
});

test("modal focus takes priority over a selector", () => {
  const { overlays, focus } = createFocus();
  overlays.open(createSelectorOverlay("command-selector"));
  overlays.open(createModalOverlay("confirm-exit"));

  assert.equal(focus.current(), "confirm-exit");
});

test("closing the focused overlay restores the previous focus", () => {
  const { overlays, focus } = createFocus();
  overlays.open(COMPLETION_OVERLAY);
  overlays.open(createSelectorOverlay("command-selector"));
  overlays.open(createModalOverlay("confirm-exit"));

  overlays.close("confirm-exit");
  assert.equal(focus.current(), "command-selector");

  overlays.close("command-selector");
  assert.equal(focus.current(), "completion");

  overlays.close("completion");
  assert.equal(focus.current(), "composer");
});

test("live completion Enter accepts a partial command and submits it", () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
    commandRegistry: exitRegistry,
  });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  ui.feedInputBytes(encoder.encode("/e\r"));
  ui.drainLoop();

  assert.deepEqual(submitted, ["/exit"]);
});

test("live completion Enter submits an exact command", () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
    commandRegistry: exitRegistry,
  });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  ui.feedInputBytes(encoder.encode("/exit\r"));
  ui.drainLoop();

  assert.deepEqual(submitted, ["/exit"]);
});

test("live completion Escape dismisses the completion menu", () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
    commandRegistry: exitRegistry,
  });
  ui.startLoop(() => {});

  ui.feedInputBytes(encoder.encode("/e\x1b[27u"));
  ui.drainLoop();

  assert.deepEqual(ui.interactiveLoop?.editor.completions, []);
});
