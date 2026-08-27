import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPLETION_OVERLAY,
  COMPOSER_COMPONENT,
  createModalOverlay,
  createSelectorOverlay,
} from "../packages/terminal/tui/src/tui/components.ts";
import { FocusManager } from "../packages/terminal/tui/src/tui/focus-manager.ts";
import { OverlayManager } from "../packages/terminal/tui/src/tui/overlay-manager.ts";
import type { FocusableComponent } from "../packages/terminal/tui/src/tui/component.ts";
import { TerminalUI, type CommandRegistryLike } from "../packages/terminal/tui/src/tui/ui.ts";
import { MemoryTerminalDriver } from "../packages/terminal/tui/src/tui/screen.ts";

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

function focusableComponent(): FocusableComponent {
  return {
    focused: false,
    render: () => ({ lines: [] }),
    invalidate: () => {},
  };
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
  overlays.open(createSelectorOverlay("command-selector", focusableComponent()));

  assert.equal(focus.current(), "command-selector");
});

test("modal focus takes priority over a selector", () => {
  const { overlays, focus } = createFocus();
  overlays.open(createSelectorOverlay("command-selector", focusableComponent()));
  overlays.open(createModalOverlay("confirm-exit", focusableComponent()));

  assert.equal(focus.current(), "confirm-exit");
});

test("closing the focused overlay restores the previous focus", () => {
  const { overlays, focus } = createFocus();
  overlays.open(COMPLETION_OVERLAY);
  overlays.open(createSelectorOverlay("command-selector", focusableComponent()));
  overlays.open(createModalOverlay("confirm-exit", focusableComponent()));

  overlays.close("confirm-exit");
  assert.equal(focus.current(), "command-selector");

  overlays.close("command-selector");
  assert.equal(focus.current(), "completion");

  overlays.close("completion");
  assert.equal(focus.current(), "composer");
});

test("overlay ownership focuses the top component and restores the previous component", () => {
  const { overlays } = createFocus();
  const selector = focusableComponent();
  const modal = focusableComponent();

  overlays.open(createSelectorOverlay("command-selector", selector));
  assert.equal(selector.focused, true);

  overlays.open(createModalOverlay("confirm-exit", modal));
  assert.equal(selector.focused, false);
  assert.equal(modal.focused, true);

  overlays.close("confirm-exit");
  assert.equal(selector.focused, true);
  assert.equal(modal.focused, false);
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
