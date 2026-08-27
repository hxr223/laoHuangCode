import type { OverlayEntry } from "./overlay-manager.ts";

export type {
  ComponentRenderResult,
  RenderContext,
  SpanStyle,
  StyledLine,
  StyledSpan,
  StyleToken,
} from "./render-model.ts";

export { Box, type BoxOptions } from "./components/primitives/box.ts";
export { SearchInput, type SearchInputOptions } from "./components/primitives/search-input.ts";
export {
  SelectList,
  type SelectItem,
  type SelectListOptions,
} from "./components/primitives/select-list.ts";
export { Text, type TextOptions } from "./components/primitives/text.ts";
export { VStack, type VStackOptions } from "./components/primitives/v-stack.ts";

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
