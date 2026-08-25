import {
  ModelError,
  ModelStreamCancelled,
  type ModelAdapter,
  type ModelInfo,
  type ModelProviderInfo,
  type ModelRequest,
  modelErrorKind,
} from "@laohuang/llm";
import {
  type Api,
  type Model as PiModel,
  type Models,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { toPiContext } from "./context.ts";
import { consumePiEvents } from "./stream.ts";

export interface PiAiAdapterOptions {
  readonly enabledProviders: readonly string[];
  readonly resolveApiKey: (
    provider: string,
  ) => string | null | Promise<string | null>;
}

export function createPiAiAdapter(options: PiAiAdapterOptions): ModelAdapter {
  return new PiAiAdapter(options, builtinModels());
}

export class PiAiAdapter implements ModelAdapter {
  readonly name = "pi-ai";
  private readonly enabledProviders: readonly string[];
  private readonly resolveApiKey: PiAiAdapterOptions["resolveApiKey"];
  private readonly models: Pick<
    Models,
    "getProviders" | "getProvider" | "getModels" | "getModel" | "streamSimple"
  >;

  constructor(
    options: PiAiAdapterOptions,
    models: Pick<
      Models,
      "getProviders" | "getProvider" | "getModels" | "getModel" | "streamSimple"
    >,
  ) {
    this.enabledProviders = options.enabledProviders;
    this.resolveApiKey = options.resolveApiKey;
    this.models = models;
  }

  async runAttempt(request: ModelRequest) {
    this.checkActive(request);
    if (!this.enabledProviders.includes(request.provider)) {
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
    const apiKey = await this.resolvedApiKey(request.provider);
    this.checkActive(request);
    if (request.onRequestOpened?.() === false) {
      throw new ModelStreamCancelled("model request was cancelled before opening");
    }
    const requestModel = request.baseUrl === undefined
      ? model
      : { ...model, baseUrl: request.baseUrl };
    const options: ModelsSimpleStreamOptions = {
      ...(apiKey === null ? {} : { apiKey }),
      ...(request.cancelToken === undefined ? {} : { signal: request.cancelToken.signal }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
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
        kind: modelErrorKind(error),
        cause: error,
      });
    }
  }

  listProviders(): readonly ModelProviderInfo[] {
    return this.models
      .getProviders()
      .filter((provider) => this.enabledProviders.includes(provider.id))
      .map((provider) => ({ id: provider.id, name: provider.name }));
  }

  listModels(provider: string): readonly ModelInfo[] {
    if (!this.enabledProviders.includes(provider)) return [];
    return this.models
      .getModels(provider)
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
      }));
  }

  private async resolvedApiKey(provider: string): Promise<string | null> {
    const value = await this.resolveApiKey(provider);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
