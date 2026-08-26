/** Feature capabilities exposed by an agent runtime implementation. */

export interface RuntimeCapabilities {
  readonly streaming: boolean;
  readonly cancellation: boolean;
  readonly queuedInput: boolean;
  readonly commands: boolean;
  readonly tools: boolean;
  readonly reasoning: boolean;
}

export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  streaming: true,
  cancellation: true,
  queuedInput: true,
  commands: true,
  tools: true,
  reasoning: false,
};

export type RuntimeCapability = keyof RuntimeCapabilities;

export const ACTION_CAPABILITIES = {
  cancel: "cancellation",
  toggle_tool_output: "tools",
  select_model: "commands",
  toggle_thinking: "reasoning",
} as const;

export function unavailableActionNotice(action: keyof typeof ACTION_CAPABILITIES): string {
  if (action === "select_model") {
    return "Model selection is unavailable for this runtime.";
  }
  if (action === "toggle_thinking") {
    return "Thinking controls are unavailable for this runtime.";
  }
  if (action === "toggle_tool_output") {
    return "Tool output controls are unavailable for this runtime.";
  }
  return "Cancellation is unavailable for this runtime.";
}
