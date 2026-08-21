/**
 * Provider-neutral model adapter boundary (design doc: "Model adapter boundary").
 *
 * `CodingAgent` speaks only the neutral types defined here: {@link ModelRequest}
 * in, delta events plus a {@link StreamResult} out, and {@link ModelError} /
 * {@link classifyModelError} for failures. Each adapter translates the neutral
 * request into the provider's OpenAI-SDK request shape and normalizes errors
 * into the {@link ModelErrorKind} taxonomy. The agent keeps owning the tool
 * loop, budgets, cancellation policy, and retry/compact/notify decisions.
 *
 * Neutral event/result surface: the existing {@link DeltaEvent} /
 * {@link DeltaCallback} / {@link StreamResult} shapes from model-stream.ts are
 * reused as-is because they are already provider-clean (text, reasoning, and
 * tool-call deltas on the callback; usage and finish reason on the result).
 *
 * History: `ModelRequest.messages` is the agent's canonical history in Chat
 * Completions wire shape. Its portable subset (what survives a provider
 * switch) is defined by {@link portableMessage}; an adapter may retain opaque
 * replay state inside history for same-provider continuation (DeepSeek's
 * `reasoning_content`), which `switchModel()` discards via `portableMessage`.
 */

import { CancelToken } from "./cancellation.ts";
import {
  ChatCompletionStreamer,
  ModelStreamCancelled,
  ModelStreamError,
  type ChatCompletionsEndpoint,
  type CompleteOptions,
  type DeltaCallback,
  type StreamResult,
} from "./model-stream.ts";

/** Structural view of `client.chat` from the openai SDK (or a fake). */
export interface ChatClientLike {
  chat: { completions: ChatCompletionsEndpoint };
}

/**
 * Optional thinking/reasoning request settings. The agent never sends these
 * today; they are the seam where provider-specific thinking configuration
 * would enter. Adapters that cannot honor them reject the request.
 */
export interface ThinkingSettings {
  enabled: boolean;
}

/** Provider-neutral completion request consumed by a {@link ModelAdapter}. */
export interface ModelRequest {
  model: string;
  /** Normalized history in Chat Completions wire shape. */
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown> | null;
  requestId?: string | undefined;
  cancelToken?: CancelToken | null;
  isRequestActive?: ((requestId: string) => boolean) | null;
  onDelta?: DeltaCallback | null;
  onRequestOpened?: (() => boolean | void) | null;
  thinking?: ThinkingSettings | null;
}

/**
 * Normalized failure taxonomy. Intentionally coarse: the agent only branches
 * on `authentication` today; the other kinds exist so retry/compact/notify
 * decisions can key off a stable classification instead of SDK internals.
 * Unclassifiable failures default to `retryable` (safe: the caller may retry).
 */
export type ModelErrorKind =
  | "authentication"
  | "rate_limited"
  | "context_overflow"
  | "server"
  | "retryable";

/** A model failure normalized into the {@link ModelErrorKind} taxonomy. */
export class ModelError extends ModelStreamError {
  readonly kind: ModelErrorKind;

  constructor(
    message: string,
    options: { kind: ModelErrorKind; hadDelta?: boolean; cause?: unknown },
  ) {
    super(message, { hadDelta: options.hadDelta ?? false, cause: options.cause });
    this.name = "ModelError";
    this.kind = options.kind;
  }
}

/** Request/history/streaming behavior flags, kept minimal and honest. */
export interface ModelCapabilities {
  /** Streams deltas over the Chat Completions streaming protocol. */
  readonly streaming: boolean;
  /**
   * Replays `reasoning_content` from prior assistant messages back to the
   * provider as opaque state for same-provider tool-call continuation.
   */
  readonly reasoningReplay: boolean;
  /** Accepts {@link ThinkingSettings} on the neutral request. */
  readonly thinkingSettings: boolean;
}

/** Translates neutral requests to one provider's SDK shape and back. */
export interface ModelAdapter {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  complete(
    client: ChatClientLike,
    request: ModelRequest,
  ): Promise<StreamResult>;
}

const CONTEXT_OVERFLOW_PATTERN =
  /context length|maximum context|context window|too many tokens|reduce the length/i;
const NETWORK_PATTERN =
  /fetch failed|network|econnreset|econnrefused|etimedout|socket hang up|timed out/i;

/** Read an HTTP status off SDK errors or plain fakes; undefined when absent. */
function readStatus(record: Record<string, unknown>): unknown {
  let status = record["status_code"];
  if (status === null || status === undefined) {
    const response = record["response"];
    if (response !== null && typeof response === "object") {
      status = (response as Record<string, unknown>)["status_code"];
    }
  }
  if (status === null || status === undefined) {
    // The openai npm SDK exposes the HTTP status as `status`.
    status = record["status"];
  }
  return status;
}

/**
 * Classify an SDK/network error (or an already-wrapped one) into the
 * taxonomy, walking the `cause` chain. Signals, in priority order:
 * 401/403 → authentication, 429 → rate_limited, context-length messages →
 * context_overflow, 5xx → server, network failures → retryable.
 */
export function classifyModelError(error: unknown): ModelErrorKind {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    current !== null &&
    current !== undefined &&
    (typeof current === "object" || typeof current === "function") &&
    !seen.has(current)
  ) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const status = readStatus(record);
    if (
      status === 401 ||
      status === 403 ||
      record["name"] === "AuthenticationError"
    ) {
      return "authentication";
    }
    if (status === 429 || record["name"] === "RateLimitError") {
      return "rate_limited";
    }
    const message =
      typeof record["message"] === "string" ? record["message"] : "";
    if (CONTEXT_OVERFLOW_PATTERN.test(message)) {
      return "context_overflow";
    }
    if (typeof status === "number" && status >= 500) {
      return "server";
    }
    if (
      record["name"] === "APIConnectionError" ||
      NETWORK_PATTERN.test(message)
    ) {
      return "retryable";
    }
    current = record["cause"];
  }
  return "retryable";
}

/** Kind of a normalized {@link ModelError}, or a fresh classification. */
export function modelErrorKind(error: unknown): ModelErrorKind {
  return error instanceof ModelError ? error.kind : classifyModelError(error);
}

/**
 * Strip provider-private fields (e.g. DeepSeek `reasoning_content` replay
 * state) so a message is portable across providers. This is the definition
 * of the neutral history retained by `switchModel()`.
 */
export function portableMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const role = message["role"];
  const portable: Record<string, unknown> = { role };
  if ("content" in message) {
    portable["content"] = message["content"];
  }
  const toolCalls = message["tool_calls"];
  if (role === "assistant" && Array.isArray(toolCalls) && toolCalls.length > 0) {
    portable["tool_calls"] = toolCalls.map((call) => {
      const record = call as Record<string, unknown>;
      const fn = (record["function"] ?? {}) as Record<string, unknown>;
      return {
        id: record["id"],
        type: record["type"] ?? "function",
        function: { name: fn["name"], arguments: fn["arguments"] },
      };
    });
  }
  if (role === "tool") {
    portable["tool_call_id"] = message["tool_call_id"];
  }
  return portable;
}

/**
 * Normalize an error escaping the streamer into the taxonomy. Cancellation
 * (including stale requests) is agent policy, not a model failure, and is
 * rethrown untouched; other errors keep their message and `hadDelta` flag.
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

/**
 * Chat Completions adapter for OpenAI and OpenAI-compatible endpoints.
 * Owns the request/stream behavior by wrapping {@link ChatCompletionStreamer};
 * streaming, cancellation, stale-request handling, pre-delta retry, usage,
 * and finish validation are all preserved unchanged.
 */
export class OpenAIAdapter implements ModelAdapter {
  readonly name: string = "openai";
  readonly capabilities: ModelCapabilities = {
    streaming: true,
    reasoningReplay: false,
    thinkingSettings: false,
  };

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

  /** Neutral request → streamer options (byte-identical wire behavior). */
  protected translateRequest(request: ModelRequest): CompleteOptions {
    if (request.thinking != null) {
      throw new ModelStreamError(
        `The ${this.name} adapter does not support thinking settings`,
      );
    }
    return {
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
  }
}

/**
 * DeepSeek adapter. Shares the OpenAI streaming core (DeepSeek speaks the
 * same Chat Completions protocol and error envelope, so error classification
 * is shared); owns DeepSeek specifics: thinking-settings translation and the
 * `reasoning_content` replay convention. The replay state round-trips through
 * history via `StreamResult.messageDict()`, which emits `reasoning_content`
 * and the tool-call empty-content convention (null content is stripped);
 * this adapter guarantees that behavior by routing through the same
 * validated {@link StreamResult}.
 */
export class DeepSeekAdapter extends OpenAIAdapter {
  override readonly name = "deepseek";
  override readonly capabilities: ModelCapabilities = {
    streaming: true,
    reasoningReplay: true,
    thinkingSettings: true,
  };

  protected override translateRequest(request: ModelRequest): CompleteOptions {
    const thinking = request.thinking;
    const options = super.translateRequest({ ...request, thinking: null });
    if (thinking != null) {
      options.extraBody = { thinking: translateThinkingSettings(thinking) };
    }
    return options;
  }
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

/** Maps provider names to adapters; unknown names fall back to OpenAI. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  register(adapter: ModelAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): ModelAdapter | undefined {
    return this.adapters.get(name);
  }

  /** Resolve a provider name, defaulting to the OpenAI adapter. */
  resolve(name: string | null | undefined): ModelAdapter {
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

/** Built-in registry with the two first-party adapters. */
export const defaultAdapterRegistry = new AdapterRegistry();
defaultAdapterRegistry.register(new OpenAIAdapter());
defaultAdapterRegistry.register(new DeepSeekAdapter());

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
