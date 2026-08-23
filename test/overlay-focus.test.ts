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
