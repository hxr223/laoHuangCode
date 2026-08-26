import {
  ModelError,
  ModelStreamCancelled,
  type ModelAdapter,
  type ModelRequest,
  modelErrorKind,
} from "@laohuang/llm";
import {
  type Api,
  type Model as PiModel,
  ModelsError,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { toPiContext } from "./context.ts";
import { consumePiEvents } from "./stream.ts";

export interface PiAiAdapterOptions {
  readonly eligibleProviderIds: ReadonlySet<string>;
}

export function createPiAiAdapter(options: PiAiAdapterOptions): PiAiAdapter {
  return new PiAiAdapter(options, builtinModels());
}

export class PiAiAdapter implements ModelAdapter {
  readonly name = "pi-ai";
  private readonly models: Pick<
    Models,
    "getProviders" | "getProvider" | "getModels" | "getModel" | "streamSimple"
  >;
  private readonly eligibleProviderIds: ReadonlySet<string>;

  constructor(
    options: PiAiAdapterOptions,
    models: Pick<
      Models,
      "getProviders" | "getProvider" | "getModels" | "getModel" | "streamSimple"
    >,
  ) {
    this.eligibleProviderIds = options.eligibleProviderIds;
    this.models = models;
  }

  async runAttempt(request: ModelRequest) {
    this.checkActive(request);
    if (!this.eligibleProviderIds.has(request.provider)) {
      throw new ModelError(`unsupported model provider: ${request.provider}`, {
        kind: "protocol",
      });
    }
    const model = this.models.getModel(request.provider, request.model);
    if (model === undefined) {
      throw new ModelError(
        `unknown model route: ${request.provider}/${request.model}`,
        { kind: "protocol" },
      );
    }
    this.checkActive(request);
    if (request.onRequestOpened?.() === false) {
      throw new ModelStreamCancelled("model request was cancelled before opening");
    }
    const requestModel = request.baseUrl === undefined
      ? model
      : { ...model, baseUrl: request.baseUrl };
    const options: ModelsSimpleStreamOptions = {
      ...(request.cancelToken === undefined ? {} : { signal: request.cancelToken.signal }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(model.reasoning ? { reasoning: "high" } : {}),
      maxRetries: 0,
    };
    try {
      const stream = this.models.streamSimple(
        requestModel as PiModel<Api>,
        toPiContext(request),
        options,
      );
      const result = await consumePiEvents(stream, request, request.onEvent);
      this.checkActive(request);
      return result;
    } catch (error) {
      if (error instanceof ModelError || error instanceof ModelStreamCancelled) {
        throw error;
      }
      throw new ModelError(errorMessage(error), {
        kind: piModelErrorKind(error),
        cause: error,
      });
    }
  }

  private checkActive(request: ModelRequest): void {
    if (request.cancelToken?.isCancelled()) {
      throw new ModelStreamCancelled(request.cancelToken.reason || "cancelled");
    }
    if (
      request.requestId !== undefined &&
      request.isRequestActive !== undefined &&
      !request.isRequestActive(request.requestId)
    ) {
      throw new ModelStreamCancelled("stale model request");
    }
  }
}

export function piModelErrorKind(error: unknown) {
  if (error instanceof ModelsError) {
    if (error.code === "auth" || error.code === "oauth") {
      return "authentication";
    }
    if (
      error.code === "provider" ||
      error.code === "model_source" ||
      error.code === "model_validation"
    ) {
      return "protocol";
    }
  }
  return modelErrorKind(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
