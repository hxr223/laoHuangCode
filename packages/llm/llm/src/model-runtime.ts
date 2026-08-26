import type { CancelToken, ModelRuntimeEventHandler } from "@laohuang/runtime-protocol";
import {
  ModelError,
  modelErrorKind,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelResult,
  type ReasoningEffort,
  ModelStreamCancelled,
  ModelStreamError,
} from "./model-contracts.ts";
import type { ToolSpec } from "@laohuang/tools";

/** Provider-neutral input for one model completion. */
export interface ModelRuntimeRequest {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly toolChoice: "auto" | "none";
  readonly reasoningEffort?: ReasoningEffort;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly requestId?: string;
  readonly cancelToken?: CancelToken | null;
  readonly isRequestActive?: ((requestId: string) => boolean) | null;
  readonly onDelta?: ModelRuntimeEventHandler | null;
  readonly onRequestOpened?: (() => boolean | void) | null;
}

export interface ModelRuntimeOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (
    delayMs: number,
    cancelToken: CancelToken | null,
  ) => Promise<void>;
}

/** Owns adapter invocation, cancellation preflight, and error normalization. */
export class ModelRuntime {
  private readonly adapter: ModelAdapter;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (
    delayMs: number,
    cancelToken: CancelToken | null,
  ) => Promise<void>;

  constructor(adapter: ModelAdapter, options: ModelRuntimeOptions = {}) {
    this.adapter = adapter;
    this.retryDelaysMs = validateRetryDelays(
      options.retryDelaysMs ?? [250, 1000],
    );
    this.sleep = options.sleep ?? defaultSleep;
  }

  async complete(request: ModelRuntimeRequest): Promise<ModelResult> {
    if (request.cancelToken?.isCancelled()) {
      throw new ModelStreamCancelled(request.cancelToken.reason || "cancelled");
    }
    const maxAttempts = validateMaxAttempts(request.maxAttempts ?? 3);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const adapterRequest: ModelRequest = {
        provider: request.provider,
        model: request.model,
        ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        ...(request.cancelToken == null ? {} : { cancelToken: request.cancelToken }),
        ...(request.isRequestActive == null
          ? {}
          : { isRequestActive: request.isRequestActive }),
        ...(request.onDelta == null
          ? {}
          : { onEvent: (event: ModelEvent) => forwardEvent(event, request.onDelta) }),
        ...(request.onRequestOpened == null
          ? {}
          : { onRequestOpened: request.onRequestOpened }),
      };
      try {
        return await this.adapter.runAttempt(adapterRequest);
      } catch (error) {
        const normalized = normalizeRuntimeError(error, request.cancelToken ?? null);
        if (!shouldRetry(normalized, attempt, maxAttempts)) {
          throw normalized;
        }
        const delayMs = this.retryDelaysMs[
          Math.min(attempt - 1, this.retryDelaysMs.length - 1)
        ]!;
        request.onDelta?.("model_retry_scheduled", {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          delay_ms: delayMs,
          error_kind: normalized.kind,
        });
        await this.sleep(delayMs, request.cancelToken ?? null);
      }
    }
    throw new ModelError("model retry loop exhausted", { kind: "protocol" });
  }
}

function forwardEvent(
  event: ModelEvent,
  handler: ModelRuntimeEventHandler | null | undefined,
): void {
  if (event.type === "text-delta") {
    handler?.("model_text_delta", { text: event.text });
  } else if (event.type === "reasoning-delta") {
    handler?.("model_reasoning_delta", { text: event.text });
  } else if (event.type === "tool-call-delta") {
    handler?.("model_tool_call_delta", {
      index: event.index,
      id: event.id,
      name: event.name ?? null,
      arguments: event.argumentsDelta,
    });
  } else {
    handler?.("model_response_validating", {});
  }
}

function normalizeRuntimeError(
  error: unknown,
  cancelToken: CancelToken | null,
): ModelError | ModelStreamCancelled {
  if (error instanceof ModelStreamCancelled) {
    return error;
  }
  if (cancelToken?.isCancelled()) {
    return new ModelStreamCancelled(cancelToken.reason || "cancelled", { cause: error });
  }
  if (error instanceof ModelError) {
    return error;
  }
  if (error instanceof ModelStreamError) {
    return new ModelError(error.message, {
      kind: modelErrorKind(error),
      hadDelta: error.hadDelta,
      cause: error,
    });
  }
  return new ModelError(errorMessage(error), {
    kind: modelErrorKind(error),
    cause: error,
  });
}

function shouldRetry(
  error: ModelError | ModelStreamCancelled,
  attempt: number,
  maxAttempts: number,
): error is ModelError {
  if (!(error instanceof ModelError) || attempt >= maxAttempts) {
    return false;
  }
  if (error.hadDelta) {
    return false;
  }
  return (
    error.kind === "timeout" ||
    error.kind === "rate_limited" ||
    error.kind === "server" ||
    error.kind === "retryable"
  );
}

function validateMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new RangeError("maxAttempts must be an integer from 1 through 10");
  }
  return value;
}

function validateRetryDelays(value: readonly number[]): readonly number[] {
  if (value.length === 0) {
    throw new RangeError("retryDelaysMs must not be empty");
  }
  for (const delay of value) {
    if (!Number.isInteger(delay) || delay < 0 || !Number.isFinite(delay)) {
      throw new RangeError("retryDelaysMs must contain finite non-negative integers");
    }
  }
  return [...value];
}

async function defaultSleep(
  delayMs: number,
  cancelToken: CancelToken | null,
): Promise<void> {
  if (cancelToken?.isCancelled()) {
    throw new ModelStreamCancelled(cancelToken.reason || "cancelled");
  }
  const cancelled = await cancelToken?.wait(delayMs);
  if (cancelled) {
    throw new ModelStreamCancelled(cancelToken?.reason || "cancelled");
  }
  if (cancelToken === null) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
