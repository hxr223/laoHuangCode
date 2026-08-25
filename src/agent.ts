/**
 * The model/tool loop at the heart of laoHuangCode.
 *
 * One user turn streams model completions through the provider-neutral
 * adapter boundary (model-adapter.ts), commits
 * only fully validated attempts to history (atomically, via the owning
 * session's commit hooks when present), executes tool-call batches
 * (read-only tools and multiple bash calls concurrently; any write/edit or
 * sequential-mode tool makes the whole batch serial), and enforces the
 * runtime guard rails: repeated-identical-tool-call detection plus token and
 * duration budgets. A triggered guard disables tools and asks the model for
 * one final answer from the information already gathered.
 */

import path from "node:path";

import { CancelToken } from "@laohuang/runtime-protocol";
import {
  EventKind,
  EventSource,
  type CreateEventOptions,
  type EventBus,
} from "@laohuang/runtime-protocol";
import type {
  AgentEventPublishOptions,
  AgentRuntimeContext,
  PendingInputBatchLike,
} from "@laohuang/runtime-protocol";
import {
  portableMessage,
  type ModelAdapter,
} from "@laohuang/llm";
import type {
  ToolExecutionContextLike,
  ToolExecutionMode,
  ToolRegistryLike,
  ToolResult,
} from "@laohuang/tools";
import { buildSystemPrompt } from "./system-prompt.ts";
import {
  discoverInstructions,
  loadBaselineInstructions,
  realpathOrSelf,
  renderAdditionalInstructions,
  scopeChain,
  ProjectInstructionState,
} from "./project-instructions.ts";
import {
  AgentStepRunner,
  FORCED_FINAL_PROMPT,
  type AgentStepRunnerContext,
} from "./core/agent-step-runner.ts";
import { GuardPolicy } from "./core/guard-policy.ts";
import { HistoryCommitter } from "./core/history-committer.ts";
import { ModelRuntime } from "@laohuang/llm";
import { ToolRuntime } from "@laohuang/tools";

export { FORCED_FINAL_PROMPT };

/** Raised when the model response cannot drive the agent loop. */
export class AgentError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AgentError";
  }
}

/** Raised when the active agent task is cooperatively cancelled. */
export class AgentCancelled extends AgentError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "AgentCancelled";
  }
}

export type AgentEventCallback = (
  eventType: string,
  payload: Record<string, unknown>,
) => void;

export type ToolEventCallback = (
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
) => void;

export type {
  AgentEventPublishOptions,
  PendingInputBatchLike,
} from "@laohuang/runtime-protocol";

/** Structural minimum of ToolRegistry (tools.ts) the agent relies on. */
export type AgentToolRegistry = ToolRegistryLike;

/**
 * Capabilities the owning session (session.ts) exposes to one agent run.
 * Every member is optional; without a context the agent runs standalone and
 * manages its own history commits and cancellation checks.
 */
export type AgentContext = AgentRuntimeContext & AgentStepRunnerContext;

export interface RunOptions {
  cancelToken?: CancelToken | null;
  requestId?: string | null;
  isRequestActive?: ((requestId: string) => boolean) | null;
}

export interface CodingAgentOptions {
  modelAdapter: ModelAdapter;
  model: string;
  tools: AgentToolRegistry;
  maxTotalTokens?: number;
  maxElapsedSeconds?: number;
  repeatedToolCallLimit?: number;
  onToolEvent?: ToolEventCallback | null;
  onAgentEvent?: AgentEventCallback | null;
  provider?: string | null;
  toolExecution?: ToolExecutionMode;
  /**
   * Project root used only for project-instruction loading (both this and
   * `startupCwd` must be set; omit both to disable instruction injection).
   */
  projectRoot?: string | null;
  /** Startup cwd for project-instruction discovery. */
  startupCwd?: string | null;
}

/** Execution context handed to every tool call in a batch. */
export interface AgentToolContext extends ToolExecutionContextLike {
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly toolCallId: string | null;
  readonly cancelToken: CancelToken | null;
}

const RUNTIME_EVENT_KINDS: Record<string, EventKind> = {
  model_request: EventKind.ModelRequestStarted,
  model_text_delta: EventKind.ModelTextDelta,
  model_reasoning_delta: EventKind.ModelReasoningDelta,
  model_tool_call_delta: EventKind.ModelToolCallDelta,
  model_response_validating: EventKind.ModelResponseValidating,
  model_response_committed: EventKind.ModelResponseCommitted,
  model_response_aborted: EventKind.ModelResponseAborted,
  model_error: EventKind.ModelRequestFailed,
  model_response: EventKind.ModelResponseSummary,
  tool_start: EventKind.ToolStarted,
  tool_result: EventKind.ToolFinished,
  agent_guard_triggered: EventKind.AgentGuardTriggered,
  agent_guard_failed: EventKind.AgentGuardFailed,
};

export class CodingAgent {
  model: string;
  provider: string | null;
  /** Provider-neutral model access; resolved from `provider`. */
  private adapter: ModelAdapter;
  private modelRuntime: ModelRuntime;
  private readonly toolRuntime: ToolRuntime;
  readonly tools: AgentToolRegistry;
  readonly maxTotalTokens: number;
  readonly maxElapsedSeconds: number;
  readonly repeatedToolCallLimit: number;
  readonly toolExecution: ToolExecutionMode;
  /** Conversation history in Chat Completions wire shape. */
  messages: Array<Record<string, unknown>>;
  private readonly onToolEvent: ToolEventCallback | null;
  private readonly onAgentEvent: AgentEventCallback | null;
  private readonly instructionRoot: string | null;
  private readonly startupCwd: string | null;
  private baselineInstructionsLoaded = false;
  private instructionState: ProjectInstructionState | null = null;
  private turn = 0;
  private activeContext: AgentRuntimeContext | null = null;
  private activeRequestId: string | null = null;

  constructor(options: CodingAgentOptions) {
    this.maxTotalTokens = options.maxTotalTokens ?? 100_000;
    this.maxElapsedSeconds = options.maxElapsedSeconds ?? 300;
    this.repeatedToolCallLimit = options.repeatedToolCallLimit ?? 3;
    for (const [name, value] of [
      ["maxTotalTokens", this.maxTotalTokens],
      ["maxElapsedSeconds", this.maxElapsedSeconds],
      ["repeatedToolCallLimit", this.repeatedToolCallLimit],
    ] as const) {
      if (value <= 0) {
        throw new RangeError(`${name} must be positive`);
      }
    }
    this.model = options.model;
    this.tools = options.tools;
    this.onToolEvent = options.onToolEvent ?? null;
    this.onAgentEvent = options.onAgentEvent ?? null;
    this.provider = options.provider ?? null;
    this.adapter = options.modelAdapter;
    this.modelRuntime = new ModelRuntime(this.adapter);
    this.toolExecution = options.toolExecution ?? "parallel";
    this.toolRuntime = new ToolRuntime(this.tools, {
      createExecutionContext: (toolCallId, cancelToken) =>
        makeToolContext(this.activeContext, toolCallId, cancelToken),
    });
    // Canonicalize so instruction scopes line up with the registry's
    // realpath-resolved touched paths even when the cwd contains symlinks.
    this.instructionRoot =
      options.projectRoot == null ? null : realpathOrSelf(options.projectRoot);
    this.startupCwd =
      options.startupCwd == null ? null : realpathOrSelf(options.startupCwd);
    this.messages = [{ role: "system", content: buildSystemPrompt(this.tools) }];
  }

  /** Bookkeeping for loaded project instructions (never model-visible). */
  get projectInstructionState(): ProjectInstructionState | null {
    return this.instructionState;
  }

  /** Swap the model client mid-conversation, keeping portable history. */
  switchModel(options: {
    modelAdapter: ModelAdapter;
    model: string;
    provider: string;
  }): void {
    const previousModel = this.model;
    const previousProvider = this.provider;
    this.messages = this.messages.map((message) => portableMessage(message));
    this.model = options.model;
    this.provider = options.provider;
    this.adapter = options.modelAdapter;
    this.modelRuntime = new ModelRuntime(this.adapter);
    this.emit("model_switched", {
      provider: options.provider,
      model: options.model,
      previous_model: previousModel,
      previous_provider: previousProvider,
    });
  }

  /** Run one user turn, committing only fully validated model attempts. */
  async run(
    userInput: string,
    context: AgentRuntimeContext | null = null,
    options: RunOptions = {},
  ): Promise<string> {
    let cancelToken = options.cancelToken ?? null;
    if (context !== null && cancelToken === null) {
      cancelToken = context.cancelToken ?? null;
    }
    this.activeContext = context;
    this.turn += 1;
    try {
      const runner = new AgentStepRunner({
        model: this.model,
        provider: this.provider,
        modelRuntime: this.modelRuntime,
        toolRuntime: this.toolRuntime,
        toolDefinitions: this.tools.definitions as unknown as Array<Record<string, unknown>>,
        toolExecution: this.toolExecution,
        history: new HistoryCommitter({
          messages: this.messages,
          context,
          cancelToken,
          createCancelled: (message) => new AgentCancelled(message),
        }),
        guardPolicy: new GuardPolicy({
          maxTotalTokens: this.maxTotalTokens,
          maxElapsedSeconds: this.maxElapsedSeconds,
          repeatedToolCallLimit: this.repeatedToolCallLimit,
        }),
        userInput,
        context,
        cancelToken,
        requestId: options.requestId ?? null,
        isRequestActive: options.isRequestActive ??
          ((requestId: string) => this.activeRequestId === requestId),
        onRequestId: (requestId) => {
          this.activeRequestId = requestId;
        },
        emit: (eventType, payload) => this.emit(eventType, payload),
        emitLegacy: (eventType, payload) => this.emitLegacy(eventType, payload),
        injectBaselineInstructions: (token) => this.injectBaselineInstructions(token),
        discoverForTouchedPaths: (paths) => this.discoverForTouchedPaths(paths),
        onToolEvent: (name, args, result) => {
          this.onToolEvent?.(name, args, result);
        },
        createError: (message, cause) => new AgentError(message, { cause }),
        createCancelled: (message, cause) => new AgentCancelled(message, { cause }),
      });
      return await runner.run();
    } finally {
      this.activeRequestId = null;
      this.activeContext = null;
    }
  }

  // --- History commits ---------------------------------------------------------

  /**
   * Append the rendered baseline project instructions once per session,
   * right after the first direct user message and before the first model
   * request. Append-only: the system prompt and committed history are never
   * rebuilt, and nothing is appended when no instruction files exist.
   */
  private injectBaselineInstructions(cancelToken: CancelToken | null): void {
    if (this.baselineInstructionsLoaded) {
      return;
    }
    this.baselineInstructionsLoaded = true;
    if (this.instructionRoot === null || this.startupCwd === null) {
      return;
    }
    const baseline = loadBaselineInstructions(
      this.instructionRoot,
      this.startupCwd,
    );
    this.instructionState = baseline.state;
    if (baseline.rendered === "") {
      return;
    }
    raiseIfCancelled(cancelToken);
    this.messages.push({ role: "user", content: baseline.rendered });
  }

  /**
   * DSH-style dynamic descendant discovery: for every parent directory from
   * the instruction root to each successfully touched path's directory,
   * render instructions from scopes not already represented by the
   * instruction state as one additional reminder message. Append-only and
   * duplicate-suppressed by ProjectInstructionState; a no-op when
   * instruction loading is not configured.
   */
  private discoverForTouchedPaths(touchedPaths: readonly string[]): void {
    const root = this.instructionRoot;
    if (root === null || touchedPaths.length === 0) {
      return;
    }
    const state = (this.instructionState ??= new ProjectInstructionState());
    const dirs: string[] = [];
    const seen = new Set<string>();
    for (const touched of touchedPaths) {
      const relative = path.relative(root, touched);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        continue; // Out-of-root operations yield no discovery.
      }
      for (const directory of scopeChain(root, path.dirname(touched))) {
        if (!seen.has(directory)) {
          seen.add(directory);
          dirs.push(directory);
        }
      }
    }
    if (dirs.length === 0) {
      return;
    }
    const files = discoverInstructions(root, dirs, {}, state);
    const rendered = renderAdditionalInstructions(files);
    if (rendered === "") {
      return;
    }
    this.messages.push({ role: "user", content: rendered });
  }


  // --- Events --------------------------------------------------------------------

  private emit(eventType: string, payload: Record<string, unknown>): void {
    const fullPayload = { turn: this.turn, ...payload };
    this.emitLegacy(eventType, fullPayload, false);
    this.publishRuntimeEvent(eventType, fullPayload);
  }

  private emitLegacy(
    eventType: string,
    payload: Record<string, unknown>,
    addTurn = true,
  ): void {
    if (this.onAgentEvent !== null) {
      const body = addTurn ? { turn: this.turn, ...payload } : payload;
      this.onAgentEvent(eventType, body);
    }
  }

  private publishRuntimeEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): void {
    const context = this.activeContext;
    const publisher = context?.publish;
    const bus = context?.eventBus ?? null;
    if (typeof publisher !== "function" && bus === null) {
      return;
    }
    const kindName = RUNTIME_EVENT_KINDS[eventType];
    if (kindName === undefined) {
      return;
    }
    // Streaming Bash owns its own start/output/finish events. The agent
    // supplies lifecycle events for the three synchronous file tools.
    const isToolEvent = eventType === "tool_start" || eventType === "tool_result";
    const isGuardEvent =
      eventType === "agent_guard_triggered" ||
      eventType === "agent_guard_failed";
    if (isToolEvent && payload["name"] === "bash") {
      return;
    }
    const source = isToolEvent
      ? EventSource.Tool
      : isGuardEvent
        ? EventSource.System
        : EventSource.Model;
    const correlationId = isToolEvent
      ? ((payload["tool_call_id"] as string | undefined) ?? null)
      : isGuardEvent
        ? null
        : ((payload["request_id"] as string | undefined) ?? null);
    if (typeof publisher === "function") {
      publisher.call(context, kindName, {
        source,
        correlation_id: correlationId,
        payload,
      });
    } else if (bus !== null) {
      bus.publish(
        kindName,
        busPublishOptions(
          source,
          context?.sessionId ?? null,
          context?.taskId ?? null,
          correlationId,
          payload,
        ),
      );
    }
  }
}

// --- Module-level helpers ------------------------------------------------------

function makeToolContext(
  context: AgentRuntimeContext | null,
  toolCallId: string,
  cancelToken: CancelToken | null,
): AgentToolContext {
  const sessionId = context?.sessionId ?? null;
  const taskId = context?.taskId ?? null;
  return {
    sessionId,
    taskId,
    toolCallId,
    cancelToken,
    isCancelled: () => isCancelled(cancelToken),
    cancellationReason: cancelToken?.reason || "cancelled",
    publish: (kind: string, payload: Record<string, unknown>) => {
      if (typeof context?.publish === "function") {
        context.publish(kind as EventKind, {
          source: EventSource.Tool,
          correlation_id: toolCallId,
          payload,
        });
        return;
      }
      const bus = context?.eventBus ?? null;
      if (bus !== null) {
        bus.publish(
          kind as EventKind,
          busPublishOptions(
            EventSource.Tool,
            sessionId,
            taskId,
            toolCallId,
            payload,
          ),
        );
      }
    },
  };
}

function busPublishOptions(
  source: EventSource,
  sessionId: string | null,
  taskId: string | null,
  correlationId: string | null,
  payload: Record<string, unknown>,
): Omit<CreateEventOptions<EventKind>, "sequence" | "event_id"> {
  return {
    source,
    session_id: sessionId || "local",
    task_id: taskId,
    correlation_id: correlationId,
    payload,
  } as Omit<CreateEventOptions<EventKind>, "sequence" | "event_id">;
}

function isCancelled(token: CancelToken | null): boolean {
  return token !== null && token.isCancelled();
}

function raiseIfCancelled(token: CancelToken | null): void {
  if (isCancelled(token)) {
    throw new AgentCancelled(token?.reason || "cancelled");
  }
}
