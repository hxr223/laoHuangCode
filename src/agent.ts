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

import { randomUUID } from "node:crypto";
import path from "node:path";

import { CancelToken } from "./cancellation.ts";
import {
  EventKind,
  EventSource,
  type CreateEventOptions,
  type EventBus,
} from "./events.ts";
import {
  ModelStreamCancelled,
  ModelStreamError,
  type AssembledToolCall,
} from "./model-stream.ts";
import {
  defaultAdapterRegistry,
  modelErrorKind,
  portableMessage,
  type ChatClientLike,
  type ModelAdapter,
} from "./model-adapter.ts";
import { touchedPathOf } from "./tools.ts";
import type {
  ToolDefinition,
  ToolExecutionContextLike,
  ToolExecutionMode,
  ToolResult,
  ToolSpec,
} from "./tools.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import {
  discoverInstructions,
  loadBaselineInstructions,
  realpathOrSelf,
  renderAdditionalInstructions,
  scopeChain,
  ProjectInstructionState,
} from "./project-instructions.ts";

export const FORCED_FINAL_PROMPT = `Tool use has been stopped by the runtime safety guard.
Do not call any tools. Give the user the best concise answer possible from the
information already available. Clearly state any limitation caused by stopping
tool use, but do not mention internal implementation details unless useful.`;

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

export type { ChatClientLike } from "./model-adapter.ts";

/** Structural minimum of ToolRegistry (tools.ts) the agent relies on. */
export interface AgentToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  readonly orderedSpecs: readonly ToolSpec[];
  executionMode(name: string): ToolExecutionMode | undefined;
  execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> | ToolResult;
}

/** Pending user input handed over at a session safe point. */
export interface PendingInputBatchLike {
  content?: string | undefined;
  eventIds?: readonly string[] | undefined;
}

/** Options for the session-owned publish hook. */
export interface AgentEventPublishOptions {
  source: EventSource;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * Capabilities the owning session (session.ts) exposes to one agent run.
 * Every member is optional; without a context the agent runs standalone and
 * manages its own history commits and cancellation checks.
 */
export interface AgentContext {
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly cancelToken?: CancelToken | null;
  readonly eventBus?: EventBus | null;
  publish?(kind: EventKind, options: AgentEventPublishOptions): unknown;
  /** Return false to cancel before the model request is sent. */
  modelStarted?(): boolean | void;
  /** Called once the SDK acknowledged the streaming request. */
  modelRequestOpened?(): boolean | void;
  toolsStarted?(): void;
  safePoint?(): PendingInputBatchLike | null | undefined;
  /** Atomically commit the user message; rollback undoes a failed commit. */
  commitInput?(append: () => void, rollback: () => void): boolean;
  commitPending?(
    batch: PendingInputBatchLike,
    append: () => void,
    rollback: () => void,
  ): boolean;
  /** Atomically reject history commits once cancellation has won. */
  commitIfActive?(callback: () => void): boolean;
}

export interface RunOptions {
  cancelToken?: CancelToken | null;
  requestId?: string | null;
  isRequestActive?: ((requestId: string) => boolean) | null;
}

export interface CodingAgentOptions {
  client: ChatClientLike;
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
  client: ChatClientLike;
  model: string;
  provider: string | null;
  /** Provider-neutral model access; resolved from `provider`. */
  private adapter: ModelAdapter;
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
  private activeContext: AgentContext | null = null;
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
    this.client = options.client;
    this.model = options.model;
    this.tools = options.tools;
    this.onToolEvent = options.onToolEvent ?? null;
    this.onAgentEvent = options.onAgentEvent ?? null;
    this.provider = options.provider ?? null;
    this.adapter = defaultAdapterRegistry.resolve(this.provider);
    this.toolExecution = options.toolExecution ?? "parallel";
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
  switchModel(options: {    client: unknown;
    model: string;
    provider: string;
  }): void {
    const previousModel = this.model;
    const previousProvider = this.provider;
    this.messages = this.messages.map((message) => portableMessage(message));
    this.client = options.client as ChatClientLike;
    this.model = options.model;
    this.provider = options.provider;
    this.adapter = defaultAdapterRegistry.resolve(this.provider);
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
    context: AgentContext | null = null,
    options: RunOptions = {},
  ): Promise<string> {
    let cancelToken = options.cancelToken ?? null;
    if (context !== null && cancelToken === null) {
      cancelToken = context.cancelToken ?? null;
    }
    this.activeContext = context;
    this.turn += 1;
    let toolRounds = 0;
    let modelRound = 0;
    let modelRequests = 0;
    let totalTokens = 0;
    const startedAt = performance.now();
    const repeatedCalls = new Map<string, number>();
    let guardReason: string | null = null;
    let guardEmitted = false;

    try {
      const userMessage: Record<string, unknown> = {
        role: "user",
        content: userInput,
      };
      const commitInput = context?.commitInput;
      let committed: boolean;
      if (typeof commitInput === "function") {
        committed = this.commitContextMessage(
          (append, rollback) => commitInput.call(context, append, rollback),
          userMessage,
        );
      } else {
        raiseIfCancelled(cancelToken);
        this.messages.push(userMessage);
        committed = true;
      }
      if (!committed) {
        throw new AgentCancelled("cancelled before user input commit");
      }
      this.emit("user_message", { content: userInput });
      this.injectBaselineInstructions(cancelToken);

      for (;;) {
        raiseIfCancelled(cancelToken);
        guardReason =
          guardReason ??
          this.budgetGuardReason(
            totalTokens,
            (performance.now() - startedAt) / 1000,
          );
        const forceFinal = guardReason !== null;
        if (guardReason !== null && !guardEmitted) {
          guardEmitted = true;
          this.emit(
            "agent_guard_triggered",
            this.guardPayload({
              reason: guardReason,
              toolRounds,
              modelRequests,
              totalTokens,
              startedAt,
            }),
          );
        }
        if (context?.modelStarted?.() === false) {
          throw new AgentCancelled("cancelled before model request");
        }
        modelRound += 1;
        modelRequests += 1;
        const currentRequestId =
          modelRound === 1 && options.requestId
            ? options.requestId
            : randomUUID();
        this.activeRequestId = currentRequestId;
        this.emit("model_request", {
          round: modelRound,
          request_id: currentRequestId,
          message_count: this.messages.length,
          tool_rounds: toolRounds,
          model_requests: modelRequests,
          total_tokens: totalTokens,
          force_final: forceFinal,
          guard_reason: guardReason,
        });
        const requestMessages = [...this.messages];
        if (forceFinal) {
          const systemMessage: Record<string, unknown> = {
            ...(requestMessages[0] ?? {}),
          };
          systemMessage["content"] =
            `${String(systemMessage["content"] ?? "")}\n\n${FORCED_FINAL_PROMPT}`;
          requestMessages[0] = systemMessage;
        }

        let result;
        try {
          const modelRequestOpened = context?.modelRequestOpened;
          const isRequestActive =
            options.isRequestActive ??
            ((requestId: string) => this.activeRequestId === requestId);
          result = await this.adapter.complete(this.client, {
            model: this.model,
            messages: requestMessages,
            tools: this.tools.definitions as unknown as Array<
              Record<string, unknown>
            >,
            toolChoice: forceFinal ? "none" : "auto",
            requestId: currentRequestId,
            cancelToken,
            isRequestActive,
            onDelta: (kind, payload) => {
              this.emit(kind, { round: modelRound, ...payload });
            },
            onRequestOpened: modelRequestOpened
              ? () => modelRequestOpened.call(context)
              : null,
          });
        } catch (error) {
          if (error instanceof ModelStreamCancelled) {
            // Covers StaleModelRequest as well.
            this.emit("model_response_aborted", {
              round: modelRound,
              request_id: currentRequestId,
              reason: errorMessage(error),
            });
            throw new AgentCancelled(errorMessage(error), { cause: error });
          }
          const errorPayload = {
            round: modelRound,
            request_id: currentRequestId,
            error: errorMessage(error),
          };
          if (error instanceof ModelStreamError && error.hadDelta) {
            this.emit("model_response_aborted", errorPayload);
            this.emitLegacy("model_error", errorPayload);
          } else {
            this.emit("model_error", errorPayload);
          }
          if (forceFinal) {
            const payload = this.guardPayload({
              reason: guardReason ?? "runtime safety guard",
              toolRounds,
              modelRequests,
              totalTokens,
              startedAt,
              finalError: errorMessage(error),
            });
            this.emit("agent_guard_failed", payload);
            let message = guardErrorMessage(payload);
            if (
              this.provider &&
              modelErrorKind(error) === "authentication"
            ) {
              message +=
                ` Authentication failed for ${this.provider}. ` +
                `Run /login ${this.provider} to update your API key.`;
            }
            throw new AgentError(message, { cause: error });
          }
          let message = `Model request failed: ${errorMessage(error)}`;
          if (this.provider && modelErrorKind(error) === "authentication") {
            message +=
              `\nAuthentication failed for ${this.provider}. ` +
              `Run /login ${this.provider} to update your API key.`;
          }
          throw new AgentError(message, { cause: error });
        }

        const toolCalls = [...result.toolCalls];
        let requestTokens = usageTotalTokens(result.usage);
        const tokensEstimated = requestTokens === 0;
        if (tokensEstimated) {
          requestTokens = estimateRequestTokens(
            requestMessages,
            result.messageDict(),
          );
        }
        totalTokens += requestTokens;
        this.emit("model_response", {
          round: modelRound,
          request_id: currentRequestId,
          finish_reason: result.finishReason,
          tool_call_count: toolCalls.length,
          tool_names: toolCalls.map((call) => call.function.name),
          tool_call_ids: toolCalls.map((call) => call.id),
          usage: result.usage,
          request_tokens: requestTokens,
          tokens_estimated: tokensEstimated,
          total_tokens: totalTokens,
          tool_rounds: toolRounds,
          model_requests: modelRequests,
          force_final: forceFinal,
        });
        if (forceFinal && toolCalls.length > 0) {
          this.emit("model_response_aborted", {
            round: modelRound,
            request_id: currentRequestId,
            reason: "tool call returned while tools were disabled",
          });
          const payload = this.guardPayload({
            reason: guardReason ?? "runtime safety guard",
            toolRounds,
            modelRequests,
            totalTokens,
            startedAt,
          });
          this.emit("agent_guard_failed", payload);
          throw new AgentError(guardErrorMessage(payload));
        }

        const postResponseGuard = this.budgetGuardReason(
          totalTokens,
          (performance.now() - startedAt) / 1000,
        );
        if (toolCalls.length > 0 && postResponseGuard !== null) {
          this.emit("model_response_aborted", {
            round: modelRound,
            request_id: currentRequestId,
            reason: postResponseGuard,
          });
          guardReason = postResponseGuard;
          continue;
        }

        // The complete assistant message is committed only if cancellation
        // has not won the Session coordination race.
        const assistantMessage = result.messageDict();
        const commitIfActive = context?.commitIfActive;
        if (typeof commitIfActive === "function") {
          committed = commitIfActive.call(context, () => {
            this.messages.push(assistantMessage);
          });
        } else {
          raiseIfCancelled(cancelToken);
          this.messages.push(assistantMessage);
          committed = true;
        }
        if (!committed) {
          this.emit("model_response_aborted", {
            round: modelRound,
            request_id: currentRequestId,
            reason: "cancelled before history commit",
          });
          throw new AgentCancelled("cancelled before history commit");
        }
        this.emit("model_response_committed", {
          round: modelRound,
          request_id: currentRequestId,
        });
        if (toolCalls.length === 0) {
          const content = result.content;
          if (content === null) {
            throw new AgentError("Model response had no content");
          }
          this.emit("assistant_response", {
            round: modelRound,
            content: truncateForEvent(content),
          });
          return content;
        }

        toolRounds += 1;
        context?.toolsStarted?.();
        const toolResults = await this.executeToolBatch(
          toolCalls,
          modelRound,
          cancelToken,
          context,
        );
        const repeated = this.recordRepeatedToolCalls(
          toolCalls,
          toolResults,
          repeatedCalls,
        );
        // Every committed assistant tool call must receive one paired tool
        // result, including calls cancelled before they start.
        for (let index = 0; index < toolCalls.length; index += 1) {
          this.messages.push({
            role: "tool",
            tool_call_id: toolCalls[index]?.id,
            content: JSON.stringify(toolResults[index]),
          });
        }
        raiseIfCancelled(cancelToken);
        // Dynamic descendant discovery runs only after every paired tool
        // result is committed, so reminders land between the tool results
        // and the next model request without touching earlier history.
        const touchedPaths: string[] = [];
        for (const result of toolResults) {
          const touched = touchedPathOf(result);
          if (typeof touched === "string") {
            touchedPaths.push(touched);
          }
        }
        this.discoverForTouchedPaths(touchedPaths);
        if (repeated !== null) {
          guardReason =
            `repeated tool call detected (${repeated.name} repeated ` +
            `${repeated.count} times with the same arguments and result)`;
        }
        const safePoint = context?.safePoint;
        if (context !== null && typeof safePoint === "function") {
          const pendingBatch = safePoint.call(context);
          const pendingContent = pendingBatch?.content ?? "";
          if (pendingBatch != null && pendingContent) {
            const pendingMessage: Record<string, unknown> = {
              role: "user",
              content: pendingContent,
            };
            const commitPending = context.commitPending;
            let committedPending: boolean;
            if (typeof commitPending === "function") {
              committedPending = this.commitContextMessage(
                (append, rollback) =>
                  commitPending.call(context, pendingBatch, append, rollback),
                pendingMessage,
              );
            } else {
              raiseIfCancelled(cancelToken);
              this.messages.push(pendingMessage);
              committedPending = true;
            }
            if (!committedPending) {
              throw new AgentCancelled("cancelled before pending input commit");
            }
            this.emit("user_message", {
              content: pendingContent,
              pending_event_ids: [...(pendingBatch.eventIds ?? [])],
            });
          }
        }
      }
    } finally {
      this.activeRequestId = null;
      this.activeContext = null;
    }
  }

  // --- Guard rails -----------------------------------------------------------

  private budgetGuardReason(
    totalTokens: number,
    elapsedSeconds: number,
  ): string | null {
    if (totalTokens >= this.maxTotalTokens) {
      return `token budget reached (${this.maxTotalTokens})`;
    }
    if (elapsedSeconds >= this.maxElapsedSeconds) {
      return (
        `elapsed time budget reached (${String(this.maxElapsedSeconds)} seconds)`
      );
    }
    return null;
  }

  private guardPayload(options: {
    reason: string;
    toolRounds: number;
    modelRequests: number;
    totalTokens: number;
    startedAt: number;
    finalError?: string | undefined;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      reason: options.reason,
      tool_rounds: options.toolRounds,
      model_requests: options.modelRequests,
      total_tokens: options.totalTokens,
      elapsed_ms: Math.round(performance.now() - options.startedAt),
    };
    if (options.finalError) {
      payload["final_error"] = options.finalError;
    }
    return payload;
  }

  private recordRepeatedToolCalls(
    toolCalls: readonly AssembledToolCall[],
    toolResults: ToolResult[],
    counts: Map<string, number>,
  ): { name: string; count: number } | null {
    let repeated: { name: string; count: number } | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      if (toolCall === undefined) {
        continue;
      }
      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(toolCall.function.arguments);
      } catch {
        parsedArguments = toolCall.function.arguments;
      }
      const fingerprint = stableStringify({
        name: toolCall.function.name,
        arguments: parsedArguments,
        result: stableToolResult(toolResults[index]),
      });
      const count = (counts.get(fingerprint) ?? 0) + 1;
      counts.set(fingerprint, count);
      seen.add(fingerprint);
      if (repeated === null || count > repeated.count) {
        repeated = { name: toolCall.function.name, count };
      }
    }
    for (const fingerprint of [...counts.keys()]) {
      if (!seen.has(fingerprint)) {
        counts.delete(fingerprint);
      }
    }
    return repeated !== null && repeated.count >= this.repeatedToolCallLimit
      ? repeated
      : null;
  }

  // --- Tool batch execution ----------------------------------------------------

  private async executeToolBatch(
    toolCalls: readonly AssembledToolCall[],
    modelRound: number,
    cancelToken: CancelToken | null,
    context: AgentContext | null,
  ): Promise<ToolResult[]> {
    interface Prepared {
      offset: number;
      toolCall: AssembledToolCall;
      args: Record<string, unknown>;
      eventContext: Record<string, unknown>;
    }
    const results: Array<ToolResult | undefined> = new Array<
      ToolResult | undefined
    >(toolCalls.length).fill(undefined);
    const prepared: Prepared[] = [];

    for (let offset = 0; offset < toolCalls.length; offset += 1) {
      const toolCall = toolCalls[offset];
      if (toolCall === undefined) {
        continue;
      }
      let args: Record<string, unknown>;
      let result: ToolResult | undefined;
      try {
        const decoded: unknown = JSON.parse(toolCall.function.arguments);
        if (
          typeof decoded !== "object" ||
          decoded === null ||
          Array.isArray(decoded)
        ) {
          throw new Error("Tool arguments must be a JSON object");
        }
        args = decoded as Record<string, unknown>;
      } catch (error) {
        args = { _raw: toolCall.function.arguments };
        result = { ok: false, error: errorMessage(error) };
      }
      const eventContext: Record<string, unknown> = {
        round: modelRound,
        index: offset + 1,
        batch_size: toolCalls.length,
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
      };
      this.emit("tool_start", {
        ...eventContext,
        arguments: safeArguments(args),
      });
      if (result === undefined) {
        prepared.push({ offset, toolCall, args, eventContext });
      } else {
        results[offset] = result;
        this.finishToolEvent(toolCall.function.name, args, result, eventContext);
      }
    }

    const sequentialBatch =
      this.toolExecution === "sequential" ||
      toolCalls.some(
        (call) => this.tools.executionMode(call.function.name) === "sequential",
      ) ||
      toolCalls.some(
        (call) => call.function.name === "write" || call.function.name === "edit",
      );

    const runOne = async (item: Prepared): Promise<void> => {
      const result = isCancelled(cancelToken)
        ? cancelledToolResult(cancelToken)
        : await this.executeTool(
            item.toolCall.function.name,
            item.args,
            item.toolCall.id,
            cancelToken,
            context,
          );
      results[item.offset] = result;
      // Finish events fire in actual completion order; the returned results
      // array keeps the original call order for the model.
      this.finishToolEvent(
        item.toolCall.function.name,
        item.args,
        result,
        item.eventContext,
      );
    };

    if (sequentialBatch || prepared.length === 1) {
      for (const item of prepared) {
        await runOne(item);
      }
    } else if (prepared.length > 0) {
      await Promise.all(prepared.map((item) => runOne(item)));
    }

    return results.map(
      (result) =>
        result ?? { ok: false, error: "Tool execution produced no result" },
    );
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    cancelToken: CancelToken | null,
    context: AgentContext | null,
  ): Promise<ToolResult> {
    if (isCancelled(cancelToken)) {
      return cancelledToolResult(cancelToken);
    }
    try {
      const toolContext = makeToolContext(context, toolCallId, cancelToken);
      return await this.tools.execute(name, args, toolContext);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  private finishToolEvent(
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    eventContext: Record<string, unknown>,
  ): void {
    this.onToolEvent?.(name, args, result);
    const status = result["status"];
    this.emit("tool_result", {
      ...eventContext,
      status:
        (typeof status === "string" && status) ||
        (result["ok"] ? "completed" : "failed"),
      result: safeResult(result),
    });
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

  private commitContextMessage(
    commit: (append: () => void, rollback: () => void) => boolean,
    message: Record<string, unknown>,
  ): boolean {
    const append = (): void => {
      this.messages.push(message);
    };
    const rollback = (): void => {
      if (this.messages.at(-1) === message) {
        this.messages.pop();
      }
    };
    return Boolean(commit(append, rollback));
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
  context: AgentContext | null,
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

function cancelledToolResult(token: CancelToken | null): ToolResult {
  return {
    ok: false,
    status: "cancelled",
    error: token?.reason || "cancelled",
  };
}

function usageTotalTokens(usage: unknown): number {
  if (usage === null || usage === undefined || typeof usage !== "object") {
    return 0;
  }
  const record = usage as Record<string, unknown>;
  const total = record["total_tokens"];
  if (isJsonInteger(total)) {
    return Math.max(0, total);
  }
  const input = record["prompt_tokens"] ?? record["input_tokens"] ?? 0;
  const output = record["completion_tokens"] ?? record["output_tokens"] ?? 0;
  let sum = 0;
  for (const value of [input, output]) {
    if (isJsonInteger(value) && value > 0) {
      sum += value;
    }
  }
  return sum;
}

function isJsonInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Rough 4-bytes-per-token estimate when the API returns no usage. */
function estimateRequestTokens(
  messages: Array<Record<string, unknown>>,
  response: Record<string, unknown>,
): number {
  const serialized = JSON.stringify([...messages, response]);
  return Math.max(
    1,
    Math.floor((Buffer.byteLength(serialized, "utf8") + 3) / 4),
  );
}

/** Recursively drop the volatile duration_ms field from tool results. */
function stableToolResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableToolResult(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key !== "duration_ms") {
        result[key] = stableToolResult(item);
      }
    }
    return result;
  }
  return value;
}

/** Compact JSON with sorted object keys (Python json.dumps sort_keys). */
function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value));
}

function guardErrorMessage(payload: Record<string, unknown>): string {
  let message =
    "Agent safety guard stopped tool use but could not produce a final " +
    `answer: ${String(payload["reason"])}. ` +
    `Tool rounds: ${String(payload["tool_rounds"])}; ` +
    `model requests: ${String(payload["model_requests"])}; ` +
    `tokens counted: ${String(payload["total_tokens"])}; ` +
    `elapsed: ${String(payload["elapsed_ms"])}ms.`;
  if (payload["final_error"]) {
    message += ` Final request failed: ${String(payload["final_error"])}`;
  }
  return message;
}

function safeArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = { ...args };
  for (const key of ["content", "old_text", "new_text"]) {
    const value = safe[key];
    if (typeof value === "string") {
      safe[key] = `<${value.length} chars>`;
    }
  }
  const edits = safe["edits"];
  if (Array.isArray(edits)) {
    safe["edits"] = `<${edits.length} edits>`;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(safe)) {
    result[key] = typeof value === "string" ? truncateForEvent(value) : value;
  }
  return result;
}

function safeResult(result: ToolResult): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    safe[key] = typeof value === "string" ? truncateForEvent(value) : value;
  }
  return safe;
}

function truncateForEvent(value: string, limit = 4_000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
