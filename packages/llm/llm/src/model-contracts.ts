import type { CancelToken } from "@laohuang/runtime-protocol";
import type { ToolCall, ToolSpec } from "@laohuang/tools";

/** Raised when a streamed model response is incomplete or invalid. */
export class ModelStreamError extends Error {
  /** True when the stream had already delivered deltas before failing. */
  hadDelta: boolean;

  constructor(
    message: string,
    options: { hadDelta?: boolean; cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ModelStreamError";
    this.hadDelta = options.hadDelta ?? false;
  }
}

/** Raised when a model stream is cooperatively cancelled. */
export class ModelStreamCancelled extends ModelStreamError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "ModelStreamCancelled";
  }
}

/** Raised when chunks arrive for a request which is no longer active. */
export class StaleModelRequest extends ModelStreamCancelled {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "StaleModelRequest";
  }
}

export type AttemptState = "provisional" | "validated" | "aborted";

export interface SystemModelMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserModelMessage {
  readonly role: "user";
  readonly content: string;
}

export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningContentBlock {
  readonly type: "reasoning";
  readonly text: string;
}

export interface ToolCallContentBlock {
  readonly type: "tool-call";
  readonly call: ToolCall;
}

export type AssistantContentBlock =
  | TextContentBlock
  | ReasoningContentBlock
  | ToolCallContentBlock;

export interface ModelReplayEnvelope {
  readonly adapter: string;
  readonly version: number;
  readonly state: unknown;
}

export interface AssistantModelMessage {
  readonly role: "assistant";
  readonly provider: string;
  readonly model: string;
  readonly content: readonly AssistantContentBlock[];
  readonly replay?: ModelReplayEnvelope;
}

export interface ToolResultModelMessage {
  readonly role: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

export type ModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantModelMessage
  | ToolResultModelMessage;

export type ModelFinishReason = "stop" | "tool-calls" | "max-tokens";

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "response-validating" };

export interface ModelRequest {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly toolChoice: "auto" | "none";
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly requestId?: string;
  readonly cancelToken?: CancelToken;
  readonly isRequestActive?: (requestId: string) => boolean;
  readonly onEvent?: (event: ModelEvent) => void;
  readonly onRequestOpened?: () => boolean | void;
}

export interface ModelResult {
  readonly requestId: string;
  readonly message: AssistantModelMessage;
  readonly finishReason: ModelFinishReason;
  readonly usage: ModelUsage;
}

export interface ModelProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly authName: string;
  readonly dynamicModels: boolean;
  readonly verified: boolean;
}

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export type ModelAuthStatus =
  | { readonly configured: false }
  | { readonly configured: true; readonly source: string };

export type ApiKeySetupPrompt =
  | {
      readonly type: "text";
      readonly message: string;
      readonly placeholder?: string;
    }
  | {
      readonly type: "secret";
      readonly message: string;
      readonly placeholder?: string;
    }
  | {
      readonly type: "select";
      readonly message: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }[];
    };

export interface ApiKeySetupInteraction {
  prompt(prompt: ApiKeySetupPrompt): Promise<string>;
  notify(message: string): void;
}

export interface ModelCatalog {
  listProviders(): readonly ModelProviderInfo[];
  getProvider(provider: string): ModelProviderInfo | undefined;
  listModels(provider: string): readonly ModelInfo[];
  listAvailableModels(provider: string): Promise<readonly ModelInfo[]>;
  getModel(provider: string, model: string): ModelInfo | undefined;
  refresh(provider: string, signal?: AbortSignal): Promise<void>;
}

export interface ModelAuthService {
  status(provider: string): Promise<ModelAuthStatus>;
  loginApiKey(
    provider: string,
    interaction: ApiKeySetupInteraction,
  ): Promise<ModelAuthStatus>;
  logout(provider: string): Promise<void>;
}

export interface ModelPlatform {
  readonly adapter: ModelAdapter;
  readonly catalog: ModelCatalog;
  readonly auth: ModelAuthService;
}

/** Translates LaoHuang model requests to one provider implementation. */
export interface ModelAdapter {
  readonly name: string;
  runAttempt(request: ModelRequest): Promise<ModelResult>;
}

/**
 * Normalized failure taxonomy. Intentionally coarse: owners above the Adapter
 * make stable decisions from these kinds instead of SDK internals.
 */
export type ModelErrorKind =
  | "authentication"
  | "timeout"
  | "rate_limited"
  | "context_overflow"
  | "server"
  | "retryable"
  | "protocol";

/** A model failure normalized into the ModelErrorKind taxonomy. */
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
    status = record["status"];
  }
  return status;
}

/** Classify SDK/network errors into the stable model error taxonomy. */
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
    if (
      status === 408 ||
      status === 504 ||
      record["name"] === "TimeoutError" ||
      /\btimeout\b|\btimed out\b/i.test(message)
    ) {
      return "timeout";
    }
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

/** Kind of a normalized ModelError, or a fresh classification. */
export function modelErrorKind(error: unknown): ModelErrorKind {
  return error instanceof ModelError ? error.kind : classifyModelError(error);
}

/** Strip adapter-private replay state so history is safe across model routes. */
export function portableModelMessage(message: ModelMessage): ModelMessage {
  if (message.role !== "assistant") {
    return message;
  }
  return {
    role: "assistant",
    provider: message.provider,
    model: message.model,
    content: message.content,
  };
}
