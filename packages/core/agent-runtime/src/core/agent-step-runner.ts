import { randomUUID } from "node:crypto";

import type { CancelToken } from "@laohuang/runtime-protocol";
import {
  ModelRuntime,
  ModelStreamCancelled,
  ModelStreamError,
  modelErrorKind,
  type AssistantModelMessage,
  type ModelMessage,
  type ReasoningEffort,
  type ModelUsage,
  type TextContentBlock,
  type ToolCallContentBlock,
} from "@laohuang/llm";
import { touchedPathOf, ToolSelection, toolVersion } from "@laohuang/tools";
import type { ToolCall, ToolExecutionMode, ToolResult, ToolSpec, ToolRegistryLike } from "@laohuang/tools";
import {
  HistoryCommitter,
  type HistoryCommitContext,
} from "./history-committer.ts";
import type { PendingInputBatchLike } from "@laohuang/runtime-protocol";
import {
  RepeatToolPolicy,
  repeatToolReminder,
} from "./repeat-tool-policy.ts";
import {
  ToolRuntime,
  type ToolRuntimeToolEvent,
  type ToolRuntimeToolResultEvent,
} from "@laohuang/tools";

export interface AgentStepRunnerContext extends HistoryCommitContext {
  modelStarted?(): boolean | void;
  modelRequestOpened?(): boolean | void;
  toolsStarted?(): void;
  safePoint?(): PendingInputBatchLike | null | undefined;
}

export interface AgentContextGovernor {
  prepare(input: {
    readonly messages: readonly ModelMessage[];
    readonly tools: readonly ToolSpec[];
    readonly provider: string;
    readonly model: string;
    readonly projectTools?: (messages: readonly ModelMessage[]) => readonly ToolSpec[];
    readonly reserveTokens?: number;
    readonly pendingToolCall?: boolean;
  }): Promise<{
    readonly messages: readonly ModelMessage[];
    readonly contextTokens?: number;
    readonly contextWindow?: number;
    readonly hardInputLimit?: number;
  }>;
}

export interface AgentStepRunnerOptions {
  selection?: ToolSelection;
  model: string;
  provider: string;
  baseUrl: string | null;
  modelRuntime: ModelRuntime;
  toolRuntime: ToolRuntime;
  getTools(): ToolRegistryLike;
  prepareTools?: (signal?: AbortSignal) => Promise<void>;
  toolExecution: ToolExecutionMode;
  history: HistoryCommitter;
  contextGovernor?: AgentContextGovernor | null;
  repeatToolPolicy: RepeatToolPolicy;
  userInput: string;
  context: AgentStepRunnerContext | null;
  cancelToken: CancelToken | null;
  requestId: string | null;
  isRequestActive: (requestId: string) => boolean;
  getReasoningEffort(): ReasoningEffort;
  onRequestId(requestId: string): void;
  emit(eventType: string, payload: Record<string, unknown>): void;
  emitLegacy(eventType: string, payload: Record<string, unknown>): void;
  injectBaselineInstructions(cancelToken: CancelToken | null): void;
  discoverForTouchedPaths(touchedPaths: readonly string[]): void;
  onToolEvent(name: string, args: Record<string, unknown>, result: ToolResult): void;
  createError(message: string, cause?: unknown): Error;
  createCancelled(message: string, cause?: unknown): Error;
}

/** Runs the model/tool steps inside one user turn. */
export class AgentStepRunner {
  private readonly options: AgentStepRunnerOptions;

  constructor(options: AgentStepRunnerOptions) {
    this.options = options;
  }

  async run(): Promise<string> {
    const {
      cancelToken,
      context,
      history,
      repeatToolPolicy,
      userInput,
    } = this.options;
    let toolRounds = 0;
    let modelRound = 0;
    let modelRequests = 0;
    let totalTokens = 0;

    if (!history.commitInput(userInput)) {
      throw this.options.createCancelled("cancelled before user input commit");
    }
    this.emit("user_message", { content: userInput });
    this.options.injectBaselineInstructions(cancelToken);
    try { await this.options.prepareTools?.(cancelToken?.signal); }
    catch (error) {
      this.raiseIfCancelled();
      throw this.options.createError("Tool preparation failed", error);
    }

    for (;;) {
      this.raiseIfCancelled();
      if (context?.modelStarted?.() === false) {
        throw this.options.createCancelled("cancelled before model request");
      }
      modelRound += 1;
      modelRequests += 1;
      const requestId = modelRound === 1 && this.options.requestId !== null
        ? this.options.requestId
        : randomUUID();
      this.options.onRequestId(requestId);
      const registry = this.options.getTools();
      const selection = this.options.selection ?? new ToolSelection();
      let remainingTokens = Number.POSITIVE_INFINITY;
      let preflightCompacted = false;
      const select = (messages: readonly ModelMessage[]) => selection.prepare(registry,
        messages.map(message => message.role === "system" || message.role === "user" ? message : {}),
        async (pending, resultBytes) => {
          const snapshot = history.snapshot();
          const assistant = snapshot.at(-1);
          const reserve = Math.ceil((resultBytes + Buffer.byteLength(JSON.stringify(assistant ?? {}), "utf8")) / 4);
          const cost = reserve + pending.reduce((sum, { spec: { name, description, parameters } }) => sum + Math.ceil(Buffer.byteLength(JSON.stringify({ name, description, parameters }), "utf8") / 4) + 8, 0);
          if (cost <= remainingTokens) return true;
          if (preflightCompacted || !this.options.contextGovernor) return false;
          preflightCompacted = true;
          if (assistant?.role !== "assistant") return false;
          // The current call has no result yet. Compact only its completed prefix,
          // reserving space for the whole pending call/result/definition unit.
          try {
            const projectTools = (retained: readonly ModelMessage[]) => selection.prepare(registry,
              [...retained.map(message => message.role === "system" || message.role === "user" ? message : {}), { toolDefinitions: pending }]).view.definitions;
            const compacted = await this.options.contextGovernor.prepare({
              messages: snapshot.slice(0, -1), tools: projectTools(snapshot), projectTools,
              provider: this.options.provider, model: this.options.model, pendingToolCall: true,
              reserveTokens: reserve + 1024,
            });
            history.retain([...compacted.messages, assistant]);
            remainingTokens = compacted.hardInputLimit === undefined ? Number.POSITIVE_INFINITY
              : Math.max(0, compacted.hardInputLimit - (compacted.contextTokens ?? 0)) + cost;
            return cost <= remainingTokens;
          } catch (error) {
            if (error instanceof Error && error.name === "ContextBudgetError") return false;
            throw error;
          }
        }, () => history.snapshot().map(message => message.role === "system" || message.role === "user" ? message : {}));
      let selected = select(history.snapshot());
      if (selected.announcement) history.commitToolContext({ role: "user", ...selected.announcement });
      let prepared: { messages: readonly ModelMessage[]; contextTokens?: number; contextWindow?: number; hardInputLimit?: number } = { messages: history.snapshot() };
      for (let attempt = 0; attempt < 2; attempt++) {
        prepared = await this.options.contextGovernor?.prepare({
          messages: history.snapshot(), tools: selected.view.definitions,
          provider: this.options.provider, model: this.options.model,
          projectTools: messages => select(messages).view.definitions,
        }) ?? { messages: history.snapshot() };
        history.retain(prepared.messages);
        selected = select(prepared.messages);
        if (!selected.announcement) break;
        if (attempt === 1) throw this.options.createError("Tool catalog announcement cannot fit the retained context.");
        history.commitToolContext({ role: "user", ...selected.announcement });
      }
      remainingTokens = prepared.hardInputLimit === undefined ? Number.POSITIVE_INFINITY
        : Math.max(0, prepared.hardInputLimit - (prepared.contextTokens ?? 0) - 1024);
      const tools = selected.view;
      const definitions = tools.definitions;
      const requestMessages = [...prepared.messages];
      this.emit("model_request", {
        round: modelRound,
        request_id: requestId,
        message_count: requestMessages.length,
        tool_rounds: toolRounds,
        model_requests: modelRequests,
        total_tokens: totalTokens,
        ...(prepared.contextTokens === undefined ? {} : { context_tokens: prepared.contextTokens }),
        ...(prepared.contextWindow === undefined ? {} : { context_window: prepared.contextWindow }),
      });

      let result;
      try {
        const modelRequestOpened = context?.modelRequestOpened;
        result = await this.options.modelRuntime.complete({
          provider: this.options.provider,
          model: this.options.model,
          ...(this.options.baseUrl === null ? {} : { baseUrl: this.options.baseUrl }),
          messages: requestMessages,
          tools: definitions,
          reasoningEffort: this.options.getReasoningEffort(),
          requestId,
          cancelToken,
          isRequestActive: this.options.isRequestActive,
          onDelta: (kind, payload) => {
            this.emit(kind, { round: modelRound, request_id: requestId, ...payload });
          },
          onRequestOpened: modelRequestOpened
            ? () => modelRequestOpened.call(context)
            : null,
        });
      } catch (error) {
        if (error instanceof ModelStreamCancelled) {
          this.emit("model_response_aborted", {
            round: modelRound,
            request_id: requestId,
            reason: errorMessage(error),
          });
          throw this.options.createCancelled(errorMessage(error), error);
        }
        const errorPayload = {
          round: modelRound,
          request_id: requestId,
          error: errorMessage(error),
        };
        if (error instanceof ModelStreamError && error.hadDelta) {
          this.emit("model_response_aborted", errorPayload);
          this.options.emitLegacy("model_error", errorPayload);
        } else {
          this.emit("model_error", errorPayload);
        }
        let message = `Model request failed: ${errorMessage(error)}`;
        if (this.options.provider && modelErrorKind(error) === "authentication") {
          message += `\nAuthentication failed for ${this.options.provider}. ` +
            `Run /login ${this.options.provider} to update your API key.`;
        }
        throw this.options.createError(message, error);
      }

      const toolCalls = toolCallsOf(result.message);
      let requestTokens = usageTotalTokens(result.usage);
      const tokensEstimated = requestTokens === 0;
      if (tokensEstimated) {
        requestTokens = estimateRequestTokens(requestMessages, result.message);
      }
      totalTokens += requestTokens;
      this.emit("model_response", {
        round: modelRound,
        request_id: requestId,
        finish_reason: result.finishReason,
        tool_call_count: toolCalls.length,
        tool_names: toolCalls.map((call) => call.name),
        toolCallIds: toolCalls.map((call) => call.id),
        usage: result.usage,
        request_tokens: requestTokens,
        tokens_estimated: tokensEstimated,
        total_tokens: totalTokens,
        tool_rounds: toolRounds,
        model_requests: modelRequests,
      });

      if (!history.commitAssistant(result.message, {
        requestId,
        finishReason: result.finishReason,
      })) {
        this.emit("model_response_aborted", {
          round: modelRound,
          request_id: requestId,
          reason: "cancelled before history commit",
        });
        throw this.options.createCancelled("cancelled before history commit");
      }
      this.emit("model_response_committed", { round: modelRound, request_id: requestId });
      const text = textOf(result.message);
      if (toolCalls.length === 0) {
        if (text === "") {
          throw this.options.createError("Model response had no content");
        }
        this.emit("assistant_response", {
          round: modelRound,
          content: truncateForEvent(text),
        });
        return text;
      }

      toolRounds += 1;
      context?.toolsStarted?.();
      const toolResults = (await this.options.toolRuntime.execute({
        registry: tools,
        toolCalls,
        executionMode: this.options.toolExecution,
        cancelToken,
        onToolStart: (event) => this.startToolEvent(event, modelRound),
        onToolResult: (event) => this.completeToolEvent(event, modelRound),
      })).results;
      const repeated = repeatToolPolicy.record(toolCalls, toolResults);
      history.commitToolResults(toolCalls, toolResults);
      this.raiseIfCancelled();
      const current = new Map(this.options.getTools().definitions.map(spec => [spec.name, toolVersion(spec)]));
      const pending = selected.pending().filter(tool => current.get(tool.spec.name) === tool.version);
      if (pending.length) history.commitToolContext({ role: "system", content: "", toolDefinitions: pending });
      const touchedPaths: string[] = [];
      for (const toolResult of toolResults) {
        const touched = touchedPathOf(toolResult);
        if (typeof touched === "string") {
          touchedPaths.push(touched);
        }
      }
      this.options.discoverForTouchedPaths(touchedPaths);
      if (repeated !== null) {
        const content = repeatToolReminder(repeated);
        history.commitReminder(content);
        this.emit("agent_repeat_warning", {
          tool_name: repeated.name,
          repeat_count: repeated.count,
          content,
        });
      }
      const pendingBatch = context?.safePoint?.();
      if (pendingBatch !== null && pendingBatch !== undefined && (pendingBatch.content ?? "") !== "") {
        if (!history.commitPending(pendingBatch)) {
          throw this.options.createCancelled("cancelled before pending input commit");
        }
        this.emit("user_message", {
          content: pendingBatch.content,
          pending_event_ids: [...(pendingBatch.eventIds ?? [])],
        });
      }
    }
  }

  private startToolEvent(event: ToolRuntimeToolEvent, modelRound: number): void {
    this.emit("tool_start", {
      ...this.toolEventContext(event, modelRound),
      arguments: safeArguments(event.args),
    });
  }

  private completeToolEvent(
    event: ToolRuntimeToolResultEvent,
    modelRound: number,
  ): void {
    this.options.onToolEvent(event.toolCall.name, event.args, event.result);
    const status = event.result["status"];
    this.emit("tool_result", {
      ...this.toolEventContext(event, modelRound),
      status: (typeof status === "string" && status) ||
        (event.result["ok"] ? "completed" : "failed"),
      result: safeResult(event.result),
    });
  }

  private toolEventContext(
    event: ToolRuntimeToolEvent,
    modelRound: number,
  ): Record<string, unknown> {
    return {
      round: modelRound,
      index: event.index,
      batch_size: event.batchSize,
      toolCallId: event.toolCall.id,
      name: event.toolCall.name,
    };
  }

  private emit(eventType: string, payload: Record<string, unknown>): void {
    this.options.emit(eventType, payload);
  }

  private isCancelled(): boolean {
    return this.options.cancelToken !== null && this.options.cancelToken.isCancelled();
  }

  private raiseIfCancelled(): void {
    if (this.isCancelled()) {
      throw this.options.createCancelled(this.options.cancelToken?.reason || "cancelled");
    }
  }
}

function usageTotalTokens(usage: ModelUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

function estimateRequestTokens(
  messages: readonly ModelMessage[],
  response: AssistantModelMessage,
): number {
  const serialized = JSON.stringify([...messages, response]);
  return Math.max(1, Math.floor((Buffer.byteLength(serialized, "utf8") + 3) / 4));
}

function toolCallsOf(message: AssistantModelMessage): ToolCall[] {
  return message.content
    .filter(
      (block): block is ToolCallContentBlock => block.type === "tool-call",
    )
    .map((block) => block.call);
}

function textOf(message: AssistantModelMessage): string {
  return message.content
    .filter((block): block is TextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function safeArguments(args: Record<string, unknown>): Record<string, unknown> {
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
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
