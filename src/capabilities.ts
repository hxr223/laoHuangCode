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
  reasoning: true,
};
