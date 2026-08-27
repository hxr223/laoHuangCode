import type { OverlayEntry } from "./overlay-manager.ts";
import type { FocusableComponent } from "./component.ts";

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
export { AssistantMessage, type AssistantMessageOptions } from "./components/messages/assistant-message.ts";
export { NoticeMessage, type NoticeMessageOptions } from "./components/messages/notice-message.ts";
export { ThinkingMessage, type ThinkingMessageOptions } from "./components/messages/thinking-message.ts";
export { ToolMessage, type ToolMessageOptions } from "./components/messages/tool-message.ts";
export { UserMessage, type UserMessageOptions } from "./components/messages/user-message.ts";
export { WelcomeMessage, type WelcomeMessageOptions } from "./components/messages/welcome-message.ts";
export {
  type HelpCommandViewModel,
  type PromptRequest,
  type ProviderDetailViewModel,
  type ProviderSummaryViewModel,
  type QueueStatusViewModel,
  type SelectionRequest,
} from "./components/views/contracts.ts";
export { AuthDialog, type AuthDialogOptions } from "./components/views/auth-dialog.ts";
export {
  EffortSelectorView,
  ProviderSelectorView,
  type SelectionViewOptions,
} from "./components/views/effort-selector.ts";
export { HelpView, type HelpViewOptions } from "./components/views/help-view.ts";
export { ModelSelectorView, type ModelSelectorViewOptions } from "./components/views/model-selector.ts";
export {
  ProviderDetailView,
  ProviderStatusView,
  type ProviderDetailViewOptions,
  type ProviderStatusViewOptions,
} from "./components/views/provider-status-view.ts";
export { QueueStatusView, type QueueStatusViewOptions } from "./components/views/queue-status-view.ts";
export { ViewHost } from "./view-host.ts";

export const COMPOSER_COMPONENT = "composer";

const COMPLETION_COMPONENT: FocusableComponent = {
  focused: false,
  render: () => ({ lines: [] }),
  invalidate: () => {},
};

export const COMPLETION_OVERLAY: OverlayEntry = {
  id: "completion",
  priority: "completion",
  placement: "dock",
  component: COMPLETION_COMPONENT,
};

export function createSelectorOverlay(id: string, component: FocusableComponent): OverlayEntry {
  return { id, priority: "selector", placement: "dock", component };
}

export function createModalOverlay(id: string, component: FocusableComponent): OverlayEntry {
  return { id, priority: "modal", placement: "dock", component };
}
