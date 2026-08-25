import type { CancelToken } from "@laohuang/runtime-protocol";

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

export interface AssembledFunction {
  readonly name: string;
  readonly arguments: string;
}

export interface AssembledToolCall {
  readonly id: string;
  readonly type: string;
  readonly function: AssembledFunction;
}

/** Chat Completions wire shape for one assistant tool call. */
export function toolCallToDict(
  toolCall: AssembledToolCall,
): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

/** A fully validated assistant turn, ready to commit to history. */
export class StreamResult {
  readonly requestId: string;
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly toolCalls: readonly AssembledToolCall[];
  readonly finishReason: string;
  readonly usage: unknown;

  constructor(init: {
    requestId: string;
    content: string | null;
    reasoningContent: string | null;
    toolCalls: readonly AssembledToolCall[];
    finishReason: string;
    usage?: unknown;
  }) {
    this.requestId = init.requestId;
    this.content = init.content;
    this.reasoningContent = init.reasoningContent;
    this.toolCalls = init.toolCalls;
    this.finishReason = init.finishReason;
    this.usage = init.usage ?? null;
  }

  /** Assistant message in Chat Completions wire shape (nulls stripped). */
  messageDict(): Record<string, unknown> {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: this.content,
    };
    if (this.reasoningContent) {
      message["reasoning_content"] = this.reasoningContent;
    }
    if (this.toolCalls.length > 0) {
      message["tool_calls"] = this.toolCalls.map(toolCallToDict);
    }
    for (const key of Object.keys(message)) {
      if (message[key] === null || message[key] === undefined) {
        delete message[key];
      }
    }
    return message;
  }
}

export interface DeltaEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export type DeltaCallback = (
  kind: string,
  payload: Record<string, unknown>,
) => void;

/**
 * Optional thinking/reasoning request settings. The agent never sends these
 * today; they are where provider-specific thinking configuration enters.
 */
export interface ThinkingSettings {
  enabled: boolean;
}

/** Provider-neutral completion request consumed by a ModelAdapter. */
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
 */
export type ModelErrorKind =
  | "authentication"
  | "rate_limited"
  | "context_overflow"
  | "server"
  | "retryable";

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

/** Request/history/streaming behavior flags, kept minimal and honest. */
export interface ModelCapabilities {
  /** Streams deltas over the Chat Completions streaming protocol. */
  readonly streaming: boolean;
  /**
   * Replays `reasoning_content` from prior assistant messages back to the
   * provider as opaque state for same-provider tool-call continuation.
   */
  readonly reasoningReplay: boolean;
  /** Accepts ThinkingSettings on the neutral request. */
  readonly thinkingSettings: boolean;
}

/** Translates neutral requests to one provider's SDK shape and back. */
export interface ModelAdapter<Client = unknown> {
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  complete(client: Client, request: ModelRequest): Promise<StreamResult>;
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

/** Strip provider-private fields so a message is portable across providers. */
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
