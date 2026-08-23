import type { CancelToken } from "../cancellation.ts";
import {
  ModelError,
  modelErrorKind,
  type ChatClientLike,
  type ModelAdapter,
} from "../model-adapter.ts";
import {
  ModelStreamCancelled,
  ModelStreamError,
  type AssembledToolCall,
  type StreamResult,
} from "../model-stream.ts";
import type { ModelRuntimeEventHandler } from "./runtime-events.ts";

/** Provider-neutral input for one model completion. */
export interface ModelRuntimeRequest {
  client: ChatClientLike;
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown> | null;
  requestId?: string | undefined;
  cancelToken?: CancelToken | null;
  isRequestActive?: ((requestId: string) => boolean) | null;
  onDelta?: ModelRuntimeEventHandler | null;
  onRequestOpened?: (() => boolean | void) | null;
}

/** Fully validated model output, independent of a provider SDK response. */
export interface ModelRuntimeResult {
  readonly requestId: string;
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly toolCalls: readonly AssembledToolCall[];
  readonly finishReason: string;
  readonly usage: unknown;
  messageDict(): Record<string, unknown>;
}

/** Owns adapter invocation, cancellation preflight, and error normalization. */
export class ModelRuntime {
  private readonly adapter: ModelAdapter;

  constructor(adapter: ModelAdapter) {
    this.adapter = adapter;
  }

  async complete(request: ModelRuntimeRequest): Promise<ModelRuntimeResult> {
    if (request.cancelToken?.isCancelled()) {
      throw new ModelStreamCancelled(request.cancelToken.reason || "cancelled");
    }
    try {
      const result = await this.adapter.complete(request.client, {
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice ?? null,
        requestId: request.requestId,
        cancelToken: request.cancelToken ?? null,
        isRequestActive: request.isRequestActive ?? null,
        onDelta: request.onDelta === undefined || request.onDelta === null
          ? null
          : (kind, payload) => request.onDelta?.(kind as Parameters<ModelRuntimeEventHandler>[0], payload),
        onRequestOpened: request.onRequestOpened ?? null,
      });
      return toModelRuntimeResult(result);
    } catch (error) {
      throw normalizeRuntimeError(error, request.cancelToken ?? null);
    }
  }
}

function toModelRuntimeResult(result: StreamResult): ModelRuntimeResult {
  return {
    requestId: result.requestId,
    content: result.content,
    reasoningContent: result.reasoningContent,
    toolCalls: result.toolCalls,
    finishReason: result.finishReason,
    usage: result.usage,
    messageDict: () => result.messageDict(),
  };
}

function normalizeRuntimeError(
  error: unknown,
  cancelToken: CancelToken | null,
): unknown {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
