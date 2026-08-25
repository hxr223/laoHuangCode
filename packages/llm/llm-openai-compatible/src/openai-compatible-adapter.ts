import {
  ModelError,
  ModelStreamCancelled,
  ModelStreamError,
  classifyModelError,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelErrorKind,
  type ModelRequest,
  type StreamResult,
  type ThinkingSettings,
} from "@laohuang/llm";

import {
  ChatCompletionStreamer,
  type ChatCompletionsEndpoint,
  type CompleteOptions,
} from "./model-stream.ts";

/** Structural view of `client.chat` from the openai SDK (or a fake). */
export interface ChatClientLike {
  chat: { completions: ChatCompletionsEndpoint };
}

export const OPENAI_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  reasoningReplay: false,
  thinkingSettings: false,
};

export const DEEPSEEK_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  reasoningReplay: true,
  thinkingSettings: true,
};

export interface OpenAICompatibleAdapterOptions {
  readonly provider: string;
  readonly capabilities: ModelCapabilities;
}

/**
 * Chat Completions adapter for OpenAI and OpenAI-compatible endpoints.
 * Owns the request/stream behavior by wrapping ChatCompletionStreamer.
 */
export class OpenAICompatibleAdapter implements ModelAdapter<ChatClientLike> {
  readonly name: string;
  readonly capabilities: ModelCapabilities;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.name = options.provider;
    this.capabilities = options.capabilities;
  }

  async complete(
    client: ChatClientLike,
    request: ModelRequest,
  ): Promise<StreamResult> {
    try {
      return await new ChatCompletionStreamer(
        client.chat.completions,
      ).complete(this.translateRequest(request));
    } catch (error) {
      throw normalizeModelError(error);
    }
  }

  /** Neutral request to streamer options. */
  protected translateRequest(request: ModelRequest): CompleteOptions {
    const thinking = request.thinking;
    if (thinking != null && !this.capabilities.thinkingSettings) {
      throw new ModelStreamError(
        `The ${this.name} adapter does not support thinking settings`,
      );
    }
    const options: CompleteOptions = {
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      toolChoice: request.toolChoice ?? null,
      requestId: request.requestId,
      cancelToken: request.cancelToken ?? null,
      isRequestActive: request.isRequestActive ?? null,
      onDelta: request.onDelta ?? null,
      onRequestOpened: request.onRequestOpened ?? null,
    };
    if (thinking != null) {
      options.extraBody = { thinking: translateThinkingSettings(thinking) };
    }
    return options;
  }
}

/** Maps provider names to adapters; unknown names fall back to OpenAI. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter<ChatClientLike>>();

  register(adapter: ModelAdapter<ChatClientLike>): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): ModelAdapter<ChatClientLike> | undefined {
    return this.adapters.get(name);
  }

  /** Resolve a provider name, defaulting to the OpenAI adapter. */
  resolve(name: string | null | undefined): ModelAdapter<ChatClientLike> {
    if (name) {
      const adapter = this.adapters.get(name);
      if (adapter !== undefined) {
        return adapter;
      }
    }
    const fallback = this.adapters.get("openai");
    if (fallback === undefined) {
      throw new Error("No model adapter registered for openai");
    }
    return fallback;
  }
}

/** Built-in registry with the two first-party adapter presets. */
export const defaultAdapterRegistry = new AdapterRegistry();
defaultAdapterRegistry.register(
  new OpenAICompatibleAdapter({
    provider: "openai",
    capabilities: OPENAI_CAPABILITIES,
  }),
);
defaultAdapterRegistry.register(
  new OpenAICompatibleAdapter({
    provider: "deepseek",
    capabilities: DEEPSEEK_CAPABILITIES,
  }),
);

/** Kind of a normalized ModelError, or a fresh classification. */
export function modelErrorKind(error: unknown): ModelErrorKind {
  return error instanceof ModelError ? error.kind : classifyModelError(error);
}

/**
 * Normalize an error escaping the streamer into the taxonomy. Cancellation
 * is agent policy, not a model failure, and is rethrown untouched.
 */
function normalizeModelError(error: unknown): unknown {
  if (error instanceof ModelStreamCancelled || error instanceof ModelError) {
    return error;
  }
  const kind = classifyModelError(error);
  if (error instanceof ModelStreamError) {
    return new ModelError(error.message, {
      kind,
      hadDelta: error.hadDelta,
      cause: error,
    });
  }
  return new ModelError(errorMessage(error), { kind, cause: error });
}

/** Validate neutral thinking settings and translate to DeepSeek's wire shape. */
function translateThinkingSettings(
  settings: ThinkingSettings,
): Record<string, unknown> {
  if (
    typeof settings !== "object" ||
    settings === null ||
    typeof settings.enabled !== "boolean"
  ) {
    throw new ModelStreamError(
      "DeepSeek thinking settings must be { enabled: boolean }",
    );
  }
  return { type: settings.enabled ? "enabled" : "disabled" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
