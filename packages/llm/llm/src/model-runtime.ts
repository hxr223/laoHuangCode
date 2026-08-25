import type { CancelToken, ModelRuntimeEventHandler } from "@laohuang/runtime-protocol";
import {
  ModelError,
  modelErrorKind,
  type ModelAdapter,
  type ModelEvent,
  type ModelMessage,
  type ModelRequest,
  type ModelResult,
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
  readonly temperature?: number;
  readonly requestId?: string;
  readonly cancelToken?: CancelToken | null;
  readonly isRequestActive?: ((requestId: string) => boolean) | null;
  readonly onDelta?: ModelRuntimeEventHandler | null;
  readonly onRequestOpened?: (() => boolean | void) | null;
}

/** Owns adapter invocation, cancellation preflight, and error normalization. */
export class ModelRuntime {
  private readonly adapter: ModelAdapter;

  constructor(adapter: ModelAdapter) {
    this.adapter = adapter;
  }

  async complete(request: ModelRuntimeRequest): Promise<ModelResult> {
    if (request.cancelToken?.isCancelled()) {
      throw new ModelStreamCancelled(request.cancelToken.reason || "cancelled");
    }
    try {
      const adapterRequest: ModelRequest = {
        provider: request.provider,
        model: request.model,
        ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
        messages: request.messages,
        tools: request.tools,
        toolChoice: request.toolChoice,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
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
      return await this.adapter.runAttempt(adapterRequest);
    } catch (error) {
      throw normalizeRuntimeError(error, request.cancelToken ?? null);
    }
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
