import {
  ModelError,
  type ModelAttempt,
  ModelStreamCancelled,
  ModelStreamError,
  classifyModelError,
  type ModelAdapter,
  type ModelCapabilities,
  type ModelErrorKind,
  type ModelRequest,
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

export interface ChatCompletionMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  temperature: number;
  response_format: { type: "json_object" };
}

export interface ChatCompletionResponse {
  choices?:
    | Array<{ message?: { content?: string | null } | null } | null>
    | null;
}

export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionRequest,
        options?: { timeout?: number },
      ): Promise<ChatCompletionResponse>;
    };
  };
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
  readonly client: ChatClientLike;
}

/**
 * Chat Completions adapter for OpenAI and OpenAI-compatible endpoints.
 * Owns the request/stream behavior by wrapping ChatCompletionStreamer.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: ChatClientLike;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.name = options.provider;
    this.capabilities = options.capabilities;
    this.client = options.client;
  }

  async runAttempt(request: ModelRequest): Promise<ModelAttempt> {
    try {
      return await new ChatCompletionStreamer(
        this.client.chat.completions,
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
  private readonly presets = new Map<string, ModelCapabilities>();

  register(options: {
    readonly provider: string;
    readonly capabilities: ModelCapabilities;
  }): void {
    this.presets.set(options.provider, options.capabilities);
  }

  get(name: string): ModelCapabilities | undefined {
    return this.presets.get(name);
  }

  /** Resolve a provider name, defaulting to the OpenAI adapter. */
  resolve(
    name: string | null | undefined,
    client: ChatClientLike,
  ): ModelAdapter {
    if (name) {
      const capabilities = this.presets.get(name);
      if (capabilities !== undefined) {
        return new OpenAICompatibleAdapter({
          provider: name,
          capabilities,
          client,
        });
      }
    }
    const fallback = this.presets.get("openai");
    if (fallback === undefined) {
      throw new Error("No model adapter registered for openai");
    }
    return new OpenAICompatibleAdapter({
      provider: "openai",
      capabilities: fallback,
      client,
    });
  }
}

/** Built-in registry with the two first-party adapter presets. */
export const defaultAdapterRegistry = new AdapterRegistry();
defaultAdapterRegistry.register({
  provider: "openai",
  capabilities: OPENAI_CAPABILITIES,
});
defaultAdapterRegistry.register({
  provider: "deepseek",
  capabilities: DEEPSEEK_CAPABILITIES,
});

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
