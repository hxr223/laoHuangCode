/** Event-reduced terminal state, independent from the agent runtime. */

export interface ActiveResponse {
  requestId: string;
  text: string;
  status: string;
}

export interface ActiveTool {
  toolCallId: string;
  name: string;
  subject: string;
  stdout: string;
  stderr: string;
  status: string;
}

export interface UIState {
  sessionState: string;
  activeResponse: ActiveResponse | null;
  activeTools: Map<string, ActiveTool>;
  pendingCount: number;
  heldCount: number;
  provider: string;
  model: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextWindow: number;
}

export function createUIState(): UIState {
  return {
    sessionState: "IDLE",
    activeResponse: null,
    activeTools: new Map(),
    pendingCount: 0,
    heldCount: 0,
    provider: "",
    model: "",
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
  };
}

export interface UIUpdate {
  kind: string;
  text: string;
  correlationId: string;
  stream: string;
  payload: Record<string, unknown>;
}

function createUpdate(
  kind: string,
  fields: Partial<Omit<UIUpdate, "kind">> = {},
): UIUpdate {
  return {
    kind,
    text: fields.text ?? "",
    correlationId: fields.correlationId ?? "",
    stream: fields.stream ?? "",
    payload: fields.payload ?? {},
  };
}

/**
 * Minimal structural view of a canonical event. The concrete envelope type
 * is owned by events.ts; anything carrying these fields is accepted.
 */
export interface UIEventLike {
  kind?: unknown;
  type?: unknown;
  payload?: unknown;
  correlation_id?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mirror Python's `getattr(raw, "value", raw)` enum unwrapping. */
function unwrapValue(raw: unknown): unknown {
  return isRecord(raw) && "value" in raw ? raw.value : raw;
}

/** Mirror Python's `int(...)`: truncate numbers, parse numeric strings. */
function toInt(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** Turn canonical events or projected dictionaries into small UI updates. */
export class UIEventReducer {
  static readonly #TOOL_BUFFER_LIMIT = 20_000;

  readonly state: UIState;

  constructor(state?: UIState) {
    this.state = state ?? createUIState();
  }

  apply(event: UIEventLike): UIUpdate | null {
    const kind = UIEventReducer.#kindOf(event);
    const payload = UIEventReducer.#payloadOf(event);
    const correlationId = UIEventReducer.#correlationIdOf(event);

    if (kind === "ui.message") {
      return createUpdate(kind, {
        text: String(payload.text ?? ""),
        payload,
      });
    }

    if (kind === "task.state_changed") {
      const rawState = payload.state ?? "IDLE";
      this.state.sessionState = String(unwrapValue(rawState)).toUpperCase();
      this.#updateCounts(payload);
      return createUpdate(kind, { payload });
    }
    if (kind === "input.pending" || kind === "input.held") {
      this.#updateCounts(payload);
      return createUpdate(kind, { payload });
    }
    if (kind === "task.started") {
      this.state.sessionState = "RUNNING_MODEL";
      this.#updateCounts(payload);
      return createUpdate(kind, { payload });
    }
    if (
      kind === "task.completed" ||
      kind === "task.cancelled" ||
      kind === "task.failed"
    ) {
      this.state.sessionState = kind === "task.failed" ? "FAILED" : "IDLE";
      this.#updateCounts(payload);
      return createUpdate(kind, { payload });
    }

    if (kind === "model.request_started") {
      this.state.sessionState = "RUNNING_MODEL";
      this.#updateContextUsage(payload);
      this.state.activeResponse = {
        requestId: correlationId,
        text: "",
        status: "provisional",
      };
      return createUpdate(kind, { correlationId, payload });
    }
    if (kind === "model.text_delta") {
      const text = String(payload.text ?? payload.chunk ?? "");
      let response = this.state.activeResponse;
      if (response === null || response.requestId !== correlationId) {
        response = { requestId: correlationId, text: "", status: "provisional" };
        this.state.activeResponse = response;
      }
      response.text += text;
      return createUpdate(kind, { text, correlationId });
    }
    if (kind === "model.response_committed") {
      if (this.state.activeResponse !== null) {
        this.state.activeResponse.status = "committed";
      }
      return createUpdate(kind, { correlationId, payload });
    }
    if (kind === "model.response_aborted" || kind === "model.request_failed") {
      if (this.state.activeResponse !== null) {
        this.state.activeResponse.status = "aborted";
      }
      return createUpdate(kind, { correlationId, payload });
    }
    if (kind === "model.response_summary") {
      const usage = payload.usage;
      if (isRecord(usage)) {
        this.state.inputTokens += toInt(
          ("prompt_tokens" in usage ? usage.prompt_tokens : usage.input_tokens) || 0,
        );
        this.state.outputTokens += toInt(
          ("completion_tokens" in usage
            ? usage.completion_tokens
            : usage.output_tokens) || 0,
        );
      }
      this.state.totalTokens = toInt(
        ("total_tokens" in payload ? payload.total_tokens : this.state.totalTokens) ||
          0,
      );
      return createUpdate(kind, { correlationId, payload });
    }
    if (kind === "model.reasoning_delta") {
      return createUpdate(kind, {
        text: String(payload.text ?? ""),
        correlationId,
        payload,
      });
    }
    if (kind === "model.retry_scheduled") {
      return createUpdate(kind, { correlationId, payload });
    }

    if (kind === "tool.started") {
      const name = String(payload.name ?? "tool");
      const args = payload.arguments;
      let subject = "";
      if (isRecord(args)) {
        subject = String(args.command || args.path || "");
      }
      this.state.activeTools.set(correlationId, {
        toolCallId: correlationId,
        name,
        subject,
        stdout: "",
        stderr: "",
        status: "running",
      });
      this.state.sessionState = "RUNNING_TOOLS";
      return createUpdate(kind, { correlationId, payload });
    }
    if (kind === "tool.output_delta") {
      const stream = String(payload.stream ?? "stdout");
      const text = String(payload.text ?? payload.chunk ?? "");
      const tool = this.state.activeTools.get(correlationId);
      if (tool !== undefined) {
        if (stream === "stdout") {
          tool.stdout = (tool.stdout + text).slice(-UIEventReducer.#TOOL_BUFFER_LIMIT);
        } else {
          tool.stderr = (tool.stderr + text).slice(-UIEventReducer.#TOOL_BUFFER_LIMIT);
        }
      }
      return createUpdate(kind, { text, correlationId, stream });
    }
    if (kind === "tool.output_snapshot") {
      const stream = String(payload.stream ?? "stdout");
      const text = String(payload.text ?? "");
      const tool = this.state.activeTools.get(correlationId);
      if (tool !== undefined && (stream === "stdout" || stream === "stderr")) tool[stream] = text;
      return createUpdate(kind, { text, correlationId, stream, payload });
    }
    if (kind === "tool.finished") {
      const tool = this.state.activeTools.get(correlationId);
      this.state.activeTools.delete(correlationId);
      if (tool !== undefined) {
        tool.status = String(payload.status ?? "completed");
      }
      return createUpdate(kind, { correlationId, payload });
    }

    if (kind === "model.switched") {
      this.state.provider = String(
        "provider" in payload ? payload.provider : this.state.provider,
      );
      this.state.model = String(
        "model" in payload ? payload.model : this.state.model,
      );
      this.#updateContextUsage(payload);
      return createUpdate(kind, { payload });
    }

    return null;
  }

  #updateCounts(payload: Record<string, unknown>): void {
    if ("pending_count" in payload) {
      this.state.pendingCount = toInt(payload.pending_count);
    }
    if ("held_count" in payload) {
      this.state.heldCount = toInt(payload.held_count);
    }
  }

  #updateContextUsage(payload: Record<string, unknown>): void {
    if ("context_tokens" in payload) {
      this.state.contextTokens = toInt(payload.context_tokens);
    }
    if ("context_window" in payload) {
      this.state.contextWindow = toInt(payload.context_window);
    }
  }

  static #kindOf(event: UIEventLike): string {
    const raw = "kind" in event ? event.kind : event.type ?? "";
    return String(unwrapValue(raw) ?? "");
  }

  static #payloadOf(event: UIEventLike): Record<string, unknown> {
    const payload = "payload" in event ? event.payload : undefined;
    return isRecord(payload) ? payload : {};
  }

  static #correlationIdOf(event: UIEventLike): string {
    const raw = "correlation_id" in event ? event.correlation_id : "";
    return raw ? String(raw) : "";
  }
}
