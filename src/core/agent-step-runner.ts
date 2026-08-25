import { randomUUID } from "node:crypto";

import type { CancelToken } from "../cancellation.ts";
import {
  ModelStreamCancelled,
  ModelStreamError,
} from "../model-stream.ts";
import { modelErrorKind, type ChatClientLike } from "../model-adapter.ts";
import { touchedPathOf } from "../tools.ts";
import type { ToolExecutionMode, ToolResult } from "../tools.ts";
import {
  HistoryCommitter,
  type HistoryCommitContext,
} from "./history-committer.ts";
import type { PendingInputBatchLike } from "./runtime-protocol.ts";
import { GuardPolicy } from "./guard-policy.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
  ToolRuntime,
  type ToolRuntimeToolEvent,
  type ToolRuntimeToolResultEvent,
} from "./tool-runtime.ts";

export const FORCED_FINAL_PROMPT = `Tool use has been stopped by the runtime safety guard.
Do not call any tools. Give the user the best concise answer possible from the
information already available. Clearly state any limitation caused by stopping
tool use, but do not mention internal implementation details unless useful.`;

export interface AgentStepRunnerContext extends HistoryCommitContext {
  modelStarted?(): boolean | void;
  modelRequestOpened?(): boolean | void;
  toolsStarted?(): void;
  safePoint?(): PendingInputBatchLike | null | undefined;
}

export interface AgentStepRunnerOptions {
  client: ChatClientLike;
  model: string;
  provider: string | null;
  modelRuntime: ModelRuntime;
  toolRuntime: ToolRuntime;
  toolDefinitions: Array<Record<string, unknown>>;
  toolExecution: ToolExecutionMode;
  history: HistoryCommitter;
  guardPolicy: GuardPolicy;
  userInput: string;
  context: AgentStepRunnerContext | null;
  cancelToken: CancelToken | null;
  requestId: string | null;
  isRequestActive: (requestId: string) => boolean;
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
      guardPolicy,
      history,
      userInput,
    } = this.options;
    let toolRounds = 0;
    let modelRound = 0;
    let modelRequests = 0;
    let totalTokens = 0;
    const startedAt = performance.now();
    let guardReason: string | null = null;
    let guardEmitted = false;

    if (!history.commitInput(userInput)) {
      throw this.options.createCancelled("cancelled before user input commit");
    }
    this.emit("user_message", { content: userInput });
    this.options.injectBaselineInstructions(cancelToken);

    for (;;) {
      this.raiseIfCancelled();
      guardReason = guardReason ?? guardPolicy.budgetReason(
        totalTokens,
        (performance.now() - startedAt) / 1000,
      );
      const forceFinal = guardReason !== null;
      if (guardReason !== null && !guardEmitted) {
        guardEmitted = true;
        this.emit("agent_guard_triggered", this.guardPayload({
          reason: guardReason,
          toolRounds,
          modelRequests,
          totalTokens,
          startedAt,
        }));
      }
      if (context?.modelStarted?.() === false) {
        throw this.options.createCancelled("cancelled before model request");
      }
      modelRound += 1;
      modelRequests += 1;
      const requestId = modelRound === 1 && this.options.requestId !== null
        ? this.options.requestId
        : randomUUID();
      this.options.onRequestId(requestId);
      this.emit("model_request", {
        round: modelRound,
        request_id: requestId,
        message_count: history.snapshot().length,
        tool_rounds: toolRounds,
        model_requests: modelRequests,
        total_tokens: totalTokens,
        force_final: forceFinal,
        guard_reason: guardReason,
      });
      const requestMessages = history.snapshot();
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
        result = await this.options.modelRuntime.complete({
          client: this.options.client,
          model: this.options.model,
          messages: requestMessages,
          tools: this.options.toolDefinitions,
          toolChoice: forceFinal ? "none" : "auto",
          requestId,
          cancelToken,
          isRequestActive: this.options.isRequestActive,
          onDelta: (kind, payload) => {
            this.emit(kind, { round: modelRound, ...payload });
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
          if (this.options.provider && modelErrorKind(error) === "authentication") {
            message += ` Authentication failed for ${this.options.provider}. ` +
              `Run /login ${this.options.provider} to update your API key.`;
          }
          throw this.options.createError(message, error);
        }
        let message = `Model request failed: ${errorMessage(error)}`;
        if (this.options.provider && modelErrorKind(error) === "authentication") {
          message += `\nAuthentication failed for ${this.options.provider}. ` +
            `Run /login ${this.options.provider} to update your API key.`;
        }
        throw this.options.createError(message, error);
      }

      const toolCalls = [...result.toolCalls];
      let requestTokens = usageTotalTokens(result.usage);
      const tokensEstimated = requestTokens === 0;
      if (tokensEstimated) {
        requestTokens = estimateRequestTokens(requestMessages, result.messageDict());
      }
      totalTokens += requestTokens;
      this.emit("model_response", {
        round: modelRound,
        request_id: requestId,
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
          request_id: requestId,
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
        throw this.options.createError(guardErrorMessage(payload));
      }

      const postResponseGuard = guardPolicy.budgetReason(
        totalTokens,
        (performance.now() - startedAt) / 1000,
      );
      if (toolCalls.length > 0 && postResponseGuard !== null) {
        this.emit("model_response_aborted", {
          round: modelRound,
          request_id: requestId,
          reason: postResponseGuard,
        });
        guardReason = postResponseGuard;
        continue;
      }

      const assistantMessage = result.messageDict();
      if (!history.commitAssistant(assistantMessage)) {
        this.emit("model_response_aborted", {
          round: modelRound,
          request_id: requestId,
          reason: "cancelled before history commit",
        });
        throw this.options.createCancelled("cancelled before history commit");
      }
      this.emit("model_response_committed", { round: modelRound, request_id: requestId });
      if (toolCalls.length === 0) {
        if (result.content === null) {
          throw this.options.createError("Model response had no content");
        }
        this.emit("assistant_response", {
          round: modelRound,
          content: truncateForEvent(result.content),
        });
        return result.content;
      }

      toolRounds += 1;
      context?.toolsStarted?.();
      const toolResults = (await this.options.toolRuntime.execute({
        toolCalls,
        executionMode: this.options.toolExecution,
        cancelToken,
        onToolStart: (event) => this.startToolEvent(event, modelRound),
        onToolResult: (event) => this.completeToolEvent(event, modelRound),
      })).results;
      const repeated = guardPolicy.recordRepeatedToolCalls(toolCalls, toolResults);
      history.commitToolResults(toolCalls, toolResults);
      this.raiseIfCancelled();
      const touchedPaths: string[] = [];
      for (const toolResult of toolResults) {
        const touched = touchedPathOf(toolResult);
        if (typeof touched === "string") {
          touchedPaths.push(touched);
        }
      }
      this.options.discoverForTouchedPaths(touchedPaths);
      if (repeated !== null) {
        guardReason = `repeated tool call detected (${repeated.name} repeated ` +
          `${repeated.count} times with the same arguments and result)`;
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
    this.options.onToolEvent(event.toolCall.function.name, event.args, event.result);
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
      tool_call_id: event.toolCall.id,
      name: event.toolCall.function.name,
    };
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

function estimateRequestTokens(
  messages: Array<Record<string, unknown>>,
  response: Record<string, unknown>,
): number {
  const serialized = JSON.stringify([...messages, response]);
  return Math.max(1, Math.floor((Buffer.byteLength(serialized, "utf8") + 3) / 4));
}

function guardErrorMessage(payload: Record<string, unknown>): string {
  let message = "Agent safety guard stopped tool use but could not produce a final " +
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
