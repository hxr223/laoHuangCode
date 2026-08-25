import type { CancelToken } from "../cancellation.ts";
import type {
  EventBus,
  EventKind,
  EventSource,
} from "../events.ts";

export type CommandResult =
  | { readonly status: "handled" }
  | { readonly status: "not_found"; readonly command: string }
  | { readonly status: "blocked"; readonly command: string }
  | { readonly status: "exit_requested" }
  | { readonly status: "error"; readonly error: unknown };

export interface QueueStatus {
  readonly pending: number;
  readonly pendingTokens: number;
  readonly held: number;
  readonly heldTokens: number;
  readonly deadLetters: number;
}

export interface PendingInputBatchLike {
  readonly content?: string | undefined;
  readonly eventIds?: readonly string[] | undefined;
}

export interface AgentEventPublishOptions {
  source: EventSource;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

export interface AgentRuntimeContext {
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly cancelToken?: CancelToken | null;
  readonly eventBus?: EventBus | null;
  publish?(kind: EventKind, options: AgentEventPublishOptions): unknown;
  modelStarted?(): boolean | void;
  modelRequestOpened?(): boolean | void;
  toolsStarted?(): void;
  safePoint?(): PendingInputBatchLike | null | undefined;
  commitInput?(append: () => void, rollback: () => void): boolean;
  commitPending?(
    batch: PendingInputBatchLike,
    append: () => void,
    rollback: () => void,
  ): boolean;
  commitIfActive?(callback: () => void): boolean;
}

export type AgentRunnerResult = string | null | Promise<string | null>;

export interface AgentRunner {
  run(input: string, context: AgentRuntimeContext | null): AgentRunnerResult;
}
