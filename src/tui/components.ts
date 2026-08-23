import type { OverlayEntry } from "./overlay-manager.ts";

export const COMPOSER_COMPONENT = "composer";

export const COMPLETION_OVERLAY: OverlayEntry = {
  id: "completion",
  priority: "completion",
};

export function createSelectorOverlay(id: string): OverlayEntry {
  return { id, priority: "selector" };
}

export function createModalOverlay(id: string): OverlayEntry {
  return { id, priority: "modal" };
}
