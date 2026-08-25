/**
 * OpenAI-compatible Chat Completions stream assembly and validation.
 *
 * One streamed completion is buffered into a provisional {@link ModelAttempt};
 * the attempt only produces a {@link StreamResult} (the unit the agent commits
 * to history, atomically, per turn) after the whole stream validates. Late
 * deltas for a superseded request are dropped via `isRequestActive`, and a
 * cancelled attempt flushes its partial text for display but never validates,
 * so the caller has nothing to commit.
 */

import { randomUUID } from "node:crypto";

import { CancelToken } from "@laohuang/runtime-protocol";

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

/** Assemble fragmented Chat Completions tool calls by their index. */
export class ToolCallAccumulator {
  readonly index: number;
  private readonly idParts: string[] = [];
  private readonly typeParts: string[] = [];
  private readonly nameParts: string[] = [];
  private readonly argumentParts: string[] = [];

  constructor(index: number) {
    this.index = index;
  }

  add(fragment: unknown): void {
    const callId = readField(fragment, "id");
    const callType = readField(fragment, "type");
    const functionField = readField(fragment, "function");
    const name = readField(functionField, "name");
    const argumentFragment = readField(functionField, "arguments");
    if (callId) {
      this.idParts.push(String(callId));
    }
    if (callType && this.typeParts.length === 0) {
      this.typeParts.push(String(callType));
    }
    if (name) {
      this.nameParts.push(String(name));
    }
    if (argumentFragment) {
      this.argumentParts.push(String(argumentFragment));
    }
  }

  build(): AssembledToolCall {
    const callId = this.idParts.join("");
    const callType = this.typeParts.join("") || "function";
    const name = this.nameParts.join("");
    const argumentText = this.argumentParts.join("");
    if (!callId) {
      throw new ModelStreamError(
        `Tool call at index ${this.index} has no id`,
      );
    }
    if (callType !== "function") {
      throw new ModelStreamError(
        `Unsupported tool call type at index ${this.index}: ${callType}`,
      );
    }
    if (!name) {
      throw new ModelStreamError(
        `Tool call at index ${this.index} has no function name`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(argumentText);
    } catch (error) {
      throw new ModelStreamError(
        `Invalid JSON arguments for tool ${name}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new ModelStreamError(
        `Arguments for tool ${name} must be a JSON object`,
      );
    }
    return {
      id: callId,
      type: callType,
      function: { name, arguments: argumentText },
    };
  }
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

/** A provisional response which can be atomically committed after validation. */
export class ModelAttempt {
  readonly requestId: string;
  readonly contentParts: string[] = [];
  readonly reasoningParts: string[] = [];
  readonly toolCalls = new Map<number, ToolCallAccumulator>();
  finishReason: string | null = null;
  usage: unknown = null;
  receivedDelta = false;
  state: AttemptState = "provisional";

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  get content(): string {
    return this.contentParts.join("");
  }

  get reasoningContent(): string {
    return this.reasoningParts.join("");
  }

  addChoice(choice: unknown): DeltaEvent[] {
    if (this.state !== "provisional") {
      throw new ModelStreamError("Cannot append to a finished model attempt");
    }
    const events: DeltaEvent[] = [];
    const delta = readField(choice, "delta");
    if (delta !== null && delta !== undefined) {
      this.receivedDelta = true;
      const content = readField(delta, "content");
      if (content) {
        const text = String(content);
        this.contentParts.push(text);
        events.push({ kind: "model_text_delta", payload: { text } });
      }

      const reasoning = readField(delta, "reasoning_content");
      if (reasoning) {
        const text = String(reasoning);
        this.reasoningParts.push(text);
        events.push({ kind: "model_reasoning_delta", payload: { text } });
      }

      const fragments = readField(delta, "tool_calls");
      const fragmentList = Array.isArray(fragments) ? fragments : [];
      fragmentList.forEach((fragment, fallbackIndex) => {
        const rawIndex = readField(fragment, "index");
        const index = rawIndex === null || rawIndex === undefined
          ? fallbackIndex
          : Number(rawIndex);
        let accumulator = this.toolCalls.get(index);
        if (!accumulator) {
          accumulator = new ToolCallAccumulator(index);
          this.toolCalls.set(index, accumulator);
        }
        accumulator.add(fragment);
        const functionField = readField(fragment, "function");
        events.push({
          kind: "model_tool_call_delta",
          payload: {
            index,
            id: readField(fragment, "id") ?? null,
            name: readField(functionField, "name") ?? null,
            arguments: readField(functionField, "arguments") ?? null,
          },
        });
      });
    }

    const finishReason = readField(choice, "finish_reason");
    if (finishReason !== null && finishReason !== undefined) {
      const normalized = String(finishReason);
      if (this.finishReason !== null && this.finishReason !== normalized) {
        throw new ModelStreamError(
          "Model stream returned conflicting finish reasons",
        );
      }
      this.finishReason = normalized;
    }
    return events;
  }

  validate(): StreamResult {
    if (this.state !== "provisional") {
      throw new ModelStreamError("Model attempt has already finished");
    }
    const finishReason = this.finishReason;
    if (
      finishReason === "length" ||
      finishReason === "content_filter" ||
      finishReason === "insufficient_system_resource"
    ) {
      this.state = "aborted";
      throw new ModelStreamError(
        `Model response aborted with finish_reason=${finishReason}`,
      );
    }
    if (finishReason !== "stop" && finishReason !== "tool_calls") {
      this.state = "aborted";
      if (finishReason === null) {
        throw new ModelStreamError(
          "Model stream ended without a finish reason",
        );
      }
      throw new ModelStreamError(
        `Unsupported model finish reason: ${finishReason}`,
      );
    }

    let calls: AssembledToolCall[];
    try {
      calls = [...this.toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, accumulator]) => accumulator.build());
    } catch (error) {
      if (error instanceof ModelStreamError) {
        this.state = "aborted";
      }
      throw error;
    }

    const content = this.content || null;
    const reasoning = this.reasoningContent || null;
    if (finishReason === "tool_calls" && calls.length === 0) {
      this.state = "aborted";
      throw new ModelStreamError(
        "Model finished with tool_calls but supplied no tool calls",
      );
    }
    if (finishReason === "stop" && calls.length > 0) {
      this.state = "aborted";
      throw new ModelStreamError(
        "Model supplied tool calls with finish_reason=stop",
      );
    }
    if (calls.length === 0 && !content) {
      this.state = "aborted";
      throw new ModelStreamError("Model returned neither text nor tool calls");
    }

    this.state = "validated";
    return new StreamResult({
      requestId: this.requestId,
      content,
      reasoningContent: reasoning,
      toolCalls: calls,
      finishReason,
      usage: this.usage,
    });
  }

  abort(): void {
    if (this.state === "provisional") {
      this.state = "aborted";
    }
  }
}

export type DeltaCallback = (
  kind: string,
  payload: Record<string, unknown>,
) => void;

/** Emit model text at most every 40ms or once 4KB is accumulated. */
class TextDeltaCoalescer {
  private readonly callback: DeltaCallback | null;
  private readonly intervalMs: number;
  private readonly maxChars: number;
  private parts: string[] = [];
  private chars = 0;
  private requestId = "";
  private lastFlush = performance.now();

  constructor(
    callback: DeltaCallback | null,
    options: { intervalMs?: number; maxChars?: number } = {},
  ) {
    this.callback = callback;
    this.intervalMs = options.intervalMs ?? 40;
    this.maxChars = options.maxChars ?? 4096;
  }

  emit(kind: string, payload: Record<string, unknown>): void {
    if (this.callback === null) {
      return;
    }
    if (kind !== "model_text_delta") {
      this.flush();
      this.callback(kind, payload);
      return;
    }
    const text = payload["text"];
    if (typeof text !== "string" || !text) {
      return;
    }
    this.requestId = String(payload["request_id"] ?? "");
    this.parts.push(text);
    this.chars += text.length;
    if (
      this.chars >= this.maxChars ||
      performance.now() - this.lastFlush >= this.intervalMs
    ) {
      this.flush();
    }
  }

  flushIfDue(): void {
    if (
      this.parts.length > 0 &&
      performance.now() - this.lastFlush >= this.intervalMs
    ) {
      this.flush();
    }
  }

  flush(): void {
    if (this.callback === null || this.parts.length === 0) {
      return;
    }
    const text = this.parts.join("");
    this.parts = [];
    this.chars = 0;
    this.lastFlush = performance.now();
    for (let offset = 0; offset < text.length; offset += this.maxChars) {
      this.callback("model_text_delta", {
        request_id: this.requestId,
        text: text.slice(offset, offset + this.maxChars),
      });
    }
  }
}

/**
 * Minimal structural view of `client.chat.completions` from the openai SDK.
 * `create` may return the response/stream directly or a promise of it.
 */
export interface ChatCompletionsEndpoint {
  create(request: Record<string, unknown>): unknown;
}

export interface CompleteOptions {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown> | null;
  requestId?: string;
  cancelToken?: CancelToken | null;
  isRequestActive?: ((requestId: string) => boolean) | null;
  onDelta?: DeltaCallback | null;
  onRequestOpened?: (() => boolean | void) | null;
  maxPreDeltaRetries?: number;
  /** Provider-specific extra request fields, merged into the wire request. */
  extraBody?: Record<string, unknown> | null;
}

/** Create and assemble one OpenAI-compatible streaming completion. */
export class ChatCompletionStreamer {
  private readonly completions: ChatCompletionsEndpoint;

  constructor(completions: ChatCompletionsEndpoint) {
    this.completions = completions;
  }

  async complete(options: CompleteOptions): Promise<StreamResult> {
    const requestId = options.requestId ?? randomUUID();
    const cancelToken = options.cancelToken ?? null;
    const isRequestActive = options.isRequestActive ?? null;
    const onDelta = options.onDelta ?? null;
    const maxPreDeltaRetries = options.maxPreDeltaRetries ?? 1;

    const request: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.toolChoice !== null && options.toolChoice !== undefined) {
      request["tool_choice"] = options.toolChoice;
    }
    if (options.extraBody) {
      Object.assign(request, options.extraBody);
    }

    let lastError: unknown = null;

    for (let retry = 0; retry <= maxPreDeltaRetries; retry += 1) {
      const attempt = new ModelAttempt(requestId);
      const deltas = new TextDeltaCoalescer(onDelta);
      let stream: unknown = null;
      let unregisterCancel: () => void = () => {};
      try {
        ensureActive(cancelToken, isRequestActive, requestId);
        stream = await this.completions.create(request);
        if (
          options.onRequestOpened != null &&
          options.onRequestOpened() === false
        ) {
          closeStream(stream);
          throw new ModelStreamCancelled(
            "cancelled before model request acknowledgement",
          );
        }
        if (isNonStreamResponse(stream)) {
          const result = ChatCompletionStreamer.fromNonStream(
            stream,
            requestId,
          );
          ensureActive(cancelToken, isRequestActive, requestId);
          if (result.content) {
            deltas.emit("model_text_delta", {
              request_id: requestId,
              text: result.content,
            });
          }
          if (result.reasoningContent) {
            deltas.emit("model_reasoning_delta", {
              request_id: requestId,
              text: result.reasoningContent,
            });
          }
          deltas.flush();
          onDelta?.("model_response_validating", { request_id: requestId });
          return result;
        }
        if (!isIterable(stream)) {
          throw new ModelStreamError("Model returned a non-iterable stream");
        }
        if (cancelToken !== null) {
          unregisterCancel = cancelToken.register(() => {
            closeStream(stream);
          });
        }

        for await (const chunk of stream) {
          ensureActive(cancelToken, isRequestActive, requestId);
          const rawChoices = readField(chunk, "choices");
          const choices = Array.isArray(rawChoices) ? rawChoices : [];
          const usage = readField(chunk, "usage");
          if (usage !== null && usage !== undefined) {
            attempt.usage = dump(usage);
          }
          if (choices.length === 0) {
            continue;
          }
          for (const choice of choices) {
            for (const event of attempt.addChoice(choice)) {
              deltas.emit(event.kind, {
                request_id: requestId,
                ...event.payload,
              });
            }
          }
          deltas.flushIfDue();
        }

        ensureActive(cancelToken, isRequestActive, requestId);
        deltas.flush();
        onDelta?.("model_response_validating", { request_id: requestId });
        return attempt.validate();
      } catch (error) {
        deltas.flush();
        attempt.abort();
        closeStream(stream);
        if (error instanceof ModelStreamCancelled) {
          // Covers StaleModelRequest as well; never retried.
          throw error;
        }
        if (cancelToken !== null && cancelToken.isCancelled()) {
          throw new ModelStreamCancelled(cancelToken.reason || "cancelled", {
            cause: error,
          });
        }
        if (isRequestActive !== null && !isRequestActive(requestId)) {
          throw new StaleModelRequest(`Stale model request: ${requestId}`, {
            cause: error,
          });
        }
        if (attempt.receivedDelta || retry >= maxPreDeltaRetries) {
          if (error instanceof ModelStreamError) {
            error.hadDelta = attempt.receivedDelta;
            throw error;
          }
          throw new ModelStreamError(errorMessage(error), {
            hadDelta: attempt.receivedDelta,
            cause: error,
          });
        }
        // Failure before the first delta: safe to retry transparently.
        lastError = error;
      } finally {
        unregisterCancel();
      }
    }

    throw new ModelStreamError(errorMessage(lastError), { cause: lastError });
  }

  /**
   * Compatibility path for fake clients and OpenAI-compatible endpoints
   * which answer a streaming request with a plain completion object.
   */
  private static fromNonStream(
    response: unknown,
    requestId: string,
  ): StreamResult {
    const rawChoices = readField(response, "choices");
    const choices = Array.isArray(rawChoices) ? rawChoices : [];
    if (choices.length === 0) {
      throw new ModelStreamError("Model returned no choices");
    }
    const choice = choices[0];
    const message = readField(choice, "message");
    if (message === null || message === undefined) {
      throw new ModelStreamError("Model response has no message");
    }

    const rawToolCalls = readField(message, "tool_calls");
    const toolCalls = Array.isArray(rawToolCalls) ? rawToolCalls : [];
    const content = readField(message, "content") ?? null;
    const reasoning = readField(message, "reasoning_content") ?? null;
    let finishReason = readField(choice, "finish_reason");
    if (finishReason === null || finishReason === undefined) {
      finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    }

    const attempt = new ModelAttempt(requestId);
    if (content) {
      attempt.contentParts.push(String(content));
    }
    if (reasoning) {
      attempt.reasoningParts.push(String(reasoning));
    }
    toolCalls.forEach((call, index) => {
      const accumulator = new ToolCallAccumulator(index);
      accumulator.add(call);
      attempt.toolCalls.set(index, accumulator);
    });
    attempt.finishReason = String(finishReason);
    attempt.usage = dump(readField(response, "usage"));
    return attempt.validate();
  }
}

/** Read a property off SDK objects or plain fakes; null-safe. */
function readField(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "object" || typeof value === "function") {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Snapshot SDK usage objects into plain data. */
function dump(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "object") {
    const modelDump = (value as Record<string, unknown>)["model_dump"];
    if (typeof modelDump === "function") {
      return (modelDump as (this: unknown) => unknown).call(value);
    }
    if (!Array.isArray(value)) {
      return { ...(value as Record<string, unknown>) };
    }
  }
  return value;
}

function isNonStreamResponse(response: unknown): boolean {
  const choices = readField(response, "choices");
  return (
    Array.isArray(choices) &&
    choices.length > 0 &&
    readField(choices[0], "message") != null
  );
}

function isIterable(
  value: unknown,
): value is AsyncIterable<unknown> | Iterable<unknown> {
  if (value === null || value === undefined) {
    return false;
  }
  const record = value as Record<symbol, unknown>;
  return (
    typeof record[Symbol.asyncIterator] === "function" ||
    typeof record[Symbol.iterator] === "function"
  );
}

function ensureActive(
  cancelToken: CancelToken | null,
  isRequestActive: ((requestId: string) => boolean) | null,
  requestId: string,
): void {
  if (cancelToken !== null && cancelToken.isCancelled()) {
    throw new ModelStreamCancelled(cancelToken.reason || "cancelled");
  }
  if (isRequestActive !== null && !isRequestActive(requestId)) {
    throw new StaleModelRequest(`Stale model request: ${requestId}`);
  }
}

/** Close a fake stream or abort an openai SDK stream; never throws. */
function closeStream(stream: unknown): void {
  if (stream === null || stream === undefined) {
    return;
  }
  const close = readField(stream, "close");
  if (typeof close === "function") {
    try {
      (close as (this: unknown) => void).call(stream);
    } catch {
      // Best-effort cleanup only.
    }
    return;
  }
  const controller = readField(stream, "controller");
  if (controller instanceof AbortController) {
    try {
      controller.abort();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
