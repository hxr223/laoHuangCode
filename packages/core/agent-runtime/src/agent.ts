/**
 * The model/tool loop at the heart of laoHuangCode.
 *
 * One user turn streams model completions through the provider-neutral
 * adapter boundary (model-adapter.ts), commits
 * only fully validated attempts to history (atomically, via the owning
 * session's commit hooks when present), executes tool-call batches
 * (read-only tools and multiple bash calls concurrently; any write/edit or
 * sequential-mode tool makes the whole batch serial), and injects advisory
 * reminders when identical tool calls repeat. The runtime does not impose a
 * whole-turn token or elapsed-time budget and never disables model tool use.
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
  portableModelMessage,
  type ModelAdapter,
  type ModelMessage,
  type ReasoningEffort,
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
} from "@laohuang/project-instructions";
import {
  AgentStepRunner,
  type AgentStepRunnerContext,
} from "./core/agent-step-runner.ts";
import { RepeatToolPolicy } from "./core/repeat-tool-policy.ts";
import { HistoryCommitter } from "./core/history-committer.ts";
import { ModelRuntime } from "@laohuang/llm";
import { ToolRuntime, ToolSelection } from "@laohuang/tools";
import type {
  AgentContextGovernor,
} from "./core/agent-step-runner.ts";
import type {
  ConversationHistoryLike,
} from "./core/history-committer.ts";

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
  repeatToolReminderThresholds?: readonly number[];
  onToolEvent?: ToolEventCallback | null;
  onAgentEvent?: AgentEventCallback | null;
  cliName?: string | null;
  cliVersion?: string | null;
  provider: string;
  baseUrl?: string | null;
  reasoningEffort?: ReasoningEffort;
  toolExecution?: ToolExecutionMode;
  /**
   * Project root used only for project-instruction loading (both this and
   * `startupCwd` must be set; omit both to disable instruction injection).
   */
  projectRoot?: string | null;
  /** Startup cwd for project-instruction discovery. */
  startupCwd?: string | null;
  conversationHistory?: ConversationHistoryLike | null;
  contextGovernor?: AgentContextGovernor | null;
  prepareTools?: (signal?: AbortSignal) => Promise<void>;
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
  model_retry_scheduled: EventKind.ModelRetryScheduled,
  model_response_validating: EventKind.ModelResponseValidating,
  model_response_committed: EventKind.ModelResponseCommitted,
  model_response_aborted: EventKind.ModelResponseAborted,
  model_error: EventKind.ModelRequestFailed,
  model_response: EventKind.ModelResponseSummary,
  tool_start: EventKind.ToolStarted,
  tool_result: EventKind.ToolFinished,
  agent_repeat_warning: EventKind.AgentRepeatWarning,
};

export class CodingAgent {
  model: string;
  provider: string;
  baseUrl: string | null;
  /** Provider-neutral model access; resolved from `provider`. */
  private adapter: ModelAdapter;
  private modelRuntime: ModelRuntime;
  private reasoningEffort: ReasoningEffort;
  private readonly toolRuntime: ToolRuntime;
  private readonly selection = new ToolSelection();
  readonly tools: AgentToolRegistry;
  readonly repeatToolReminderThresholds: readonly number[];
  readonly toolExecution: ToolExecutionMode;
  /** Conversation history in LaoHuang model-message shape. */
  messages: ModelMessage[];
  private readonly onToolEvent: ToolEventCallback | null;
  private readonly onAgentEvent: AgentEventCallback | null;
  private readonly cliName: string | null;
  private readonly cliVersion: string | null;
  private readonly instructionRoot: string | null;
  private readonly startupCwd: string | null;
  private baselineInstructionsLoaded = false;
  private instructionState: ProjectInstructionState | null = null;
  private turn = 0;
  private activeContext: AgentRuntimeContext | null = null;
  private activeRequestId: string | null = null;
  private readonly conversationHistory: ConversationHistoryLike | null;
  private readonly contextGovernor: AgentContextGovernor | null;
  private readonly prepareTools: CodingAgentOptions["prepareTools"];

  constructor(options: CodingAgentOptions) {
    this.repeatToolReminderThresholds = normalizeReminderThresholds(
      options.repeatToolReminderThresholds ?? [3, 5, 8],
    );
    this.model = options.model;
    this.tools = options.tools;
    this.onToolEvent = options.onToolEvent ?? null;
    this.onAgentEvent = options.onAgentEvent ?? null;
    this.cliName = options.cliName ?? null;
    this.cliVersion = options.cliVersion ?? null;
    this.provider = options.provider;
    this.baseUrl = options.baseUrl ?? null;
    this.reasoningEffort = options.reasoningEffort ?? "high";
    this.adapter = options.modelAdapter;
    this.conversationHistory = options.conversationHistory ?? null;
    this.contextGovernor = options.contextGovernor ?? null;
    this.prepareTools = options.prepareTools;
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
    this.messages = [
      {
        role: "system",
        content: this.buildSystemPrompt(),
      },
    ];
  }

  /** Bookkeeping for loaded project instructions (never model-visible). */
  get projectInstructionState(): ProjectInstructionState | null {
    return this.instructionState;
  }

  getReasoningEffort(): ReasoningEffort {
    return this.reasoningEffort;
  }

  setReasoningEffort(effort: ReasoningEffort): void {
    this.reasoningEffort = effort;
  }

  /** Swap the model client mid-conversation, keeping portable history. */
  switchModel(options: {
    provider: string;
    model: string;
    baseUrl: string | null;
  }): void {
    const previousModel = this.model;
    const previousProvider = this.provider;
    this.messages = this.messages.map(portableModelMessage);
    this.provider = options.provider;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.refreshSystemPrompt();
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
        selection: this.selection,
        model: this.model,
        provider: this.provider,
        baseUrl: this.baseUrl,
        modelRuntime: this.modelRuntime,
        toolRuntime: this.toolRuntime,
        getTools: () => this.tools.snapshot?.() ?? this.tools,
        prepareTools: this.prepareTools,
        toolExecution: this.toolExecution,
        history: new HistoryCommitter({
          messages: this.messages,
          context,
          cancelToken,
          createCancelled: (message) => new AgentCancelled(message),
          conversationHistory: this.conversationHistory,
        }),
        contextGovernor: this.contextGovernor,
        repeatToolPolicy: new RepeatToolPolicy(this.repeatToolReminderThresholds),
        userInput,
        context,
        cancelToken,
        requestId: options.requestId ?? null,
        isRequestActive: options.isRequestActive ??
          ((requestId: string) => this.activeRequestId === requestId),
        getReasoningEffort: () => this.reasoningEffort,
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
    this.conversationHistory?.appendUser({
      message: { role: "user", content: baseline.rendered },
      inputEventIds: [],
      source: "direct",
    });
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
    this.conversationHistory?.appendUser({
      message: { role: "user", content: rendered },
      inputEventIds: [],
      source: "direct",
    });
    this.messages.push({ role: "user", content: rendered });
  }

  private buildSystemPrompt(): string {
    return buildSystemPrompt(this.tools, {
      cliName: this.cliName,
      cliVersion: this.cliVersion,
      provider: this.provider,
      model: this.model,
      promptCwd: this.startupCwd,
    });
  }

  private refreshSystemPrompt(): void {
    const first = this.messages[0];
    if (first?.role !== "system") {
      return;
    }
    this.messages[0] = {
      role: "system",
      content: this.buildSystemPrompt(),
    };
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
    const isRepeatWarning = eventType === "agent_repeat_warning";
    if (isToolEvent && payload["name"] === "bash") {
      return;
    }
    const source = isToolEvent
      ? EventSource.Tool
      : isRepeatWarning
        ? EventSource.System
        : EventSource.Model;
    const correlationId = isToolEvent
      ? ((payload["toolCallId"] as string | undefined) ?? null)
      : isRepeatWarning
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
    signal: cancelToken?.signal,
    isCancelled: () => isCancelled(cancelToken),
    cancellationReason: cancelToken?.reason || "cancelled",
    publish: (kind: string, payload: Record<string, unknown>) => {
      if (typeof context?.publish === "function") {
        return context.publish(kind as EventKind, {
          source: EventSource.Tool,
          correlation_id: toolCallId,
          payload,
        });
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

function normalizeReminderThresholds(values: readonly number[]): readonly number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 2 || unique.has(value)) {
      throw new RangeError(
        "repeatToolReminderThresholds must contain unique integers of at least 2",
      );
    }
    unique.add(value);
  }
  return [...unique].sort((left, right) => left - right);
}
