/** Audience-specific policy for converting runtime events into display events. */

import type { RuntimeEvent } from "@laohuang/runtime-protocol";

export type DisplayAudience = "terminal";

export interface DisplayEvent {
  readonly kind: string;
  readonly correlationId: string;
  readonly stream: string;
  readonly text: string;
  readonly payload: Record<string, unknown>;
}

export interface DisplayEventLike {
  readonly kind: unknown;
  readonly payload?: unknown;
  readonly correlation_id?: unknown;
  readonly correlationId?: unknown;
}

export interface DisplayPolicyOptions {
  audience: DisplayAudience;
  showReasoning?: boolean;
  foldToolOutput?: boolean;
}

const LIFECYCLE_EVENTS = new Set([
  "task.started",
  "task.state_changed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "session.ready",
  "session.stopped",
]);
const HIGH_FREQUENCY_EVENTS = new Set([
  "model.reasoning_delta",
  "model.tool_call_delta",
  "tool.output_delta",
]);
const TOOL_EVENTS = new Set([
  "tool.started",
  "tool.output_delta",
  "tool.finished",
]);
const SENSITIVE_FIELDS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
]);
const SENSITIVE_TEXT_PATTERNS = [
  /(authorization\s*:\s*bearer\s+)([^\s'"]+)/giu,
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s'"]+)/giu,
  /(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/giu,
];
const SENSITIVE_VALUE_AT_END = /(?:authorization\s*:\s*bearer\s+|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*[:=]\s*|--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|[^\s'"]*)$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

/** Remove credential-like values before terminal state or transcript storage. */
export function redactToolText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "$1[REDACTED]"),
    value,
  );
}

function redactToolValue(value: unknown): unknown {
  if (typeof value === "string") return redactToolText(value);
  if (Array.isArray(value)) return value.map((item) => redactToolValue(item));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_FIELDS.has(key.toLowerCase())
      ? "[REDACTED]"
      : redactToolValue(item);
  }
  return result;
}

export function redactToolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactToolValue(payload) as Record<string, unknown>;
}

/** Keeps an unfinished credential value redacted across streamed output deltas. */
export class ToolOutputRedactor {
  readonly #pendingValues = new Set<string>();

  redact(correlationId: string, stream: string, value: string): string {
    const key = `${correlationId}:${stream}`;
    let text = value;
    if (this.#pendingValues.has(key)) {
      const boundary = text.search(/\s/u);
      if (boundary < 0) return "";
      this.#pendingValues.delete(key);
      text = text.slice(boundary);
    }
    if (SENSITIVE_VALUE_AT_END.test(text)) {
      this.#pendingValues.add(key);
    }
    return redactToolText(text);
  }

  clear(correlationId: string): void {
    for (const key of this.#pendingValues) {
      if (key.startsWith(`${correlationId}:`)) this.#pendingValues.delete(key);
    }
  }
}

function droppedCount(payload: Record<string, unknown>): number {
  const value = payload._projection_dropped;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

export function displayGapMessage(dropped: number): string {
  return `… 省略了 ${dropped} 个流式展示事件；Agent 仍继续运行。`;
}

/**
 * Projects canonical EventEnvelope-shaped events and RuntimeEvent-shaped
 * values. Runtime events use camelCase task metadata, while terminal event
 * envelopes retain their existing snake_case metadata.
 */
export class DisplayPolicy {
  readonly audience: DisplayAudience;
  readonly showReasoning: boolean;
  readonly foldToolOutput: boolean;
  readonly #toolOutputRedactor = new ToolOutputRedactor();

  constructor(options: DisplayPolicyOptions) {
    this.audience = options.audience;
    this.showReasoning = options.showReasoning ?? true;
    this.foldToolOutput = options.foldToolOutput ?? options.audience === "terminal";
  }

  project(event: DisplayEventLike | RuntimeEvent): DisplayEvent[] {
    const kind = String(event.kind);
    const rawPayload = asPayload(event.payload);
    let payload = TOOL_EVENTS.has(kind) ? redactToolPayload(rawPayload) : rawPayload;
    const correlationId = this.#correlationId(event);
    const stream = String(payload.stream ?? "");
    const text = kind === "tool.output_delta"
      ? this.#toolOutputRedactor.redact(
        correlationId,
        stream || "stdout",
        String(rawPayload.text ?? rawPayload.chunk ?? ""),
      )
      : String(payload.text ?? payload.chunk ?? "");
    if (kind === "tool.output_delta") {
      payload = { ...payload, text };
    } else if (kind === "tool.finished") {
      this.#toolOutputRedactor.clear(correlationId);
    }
    const projected: DisplayEvent[] = [];
    const dropped = droppedCount(payload);

    if (dropped > 0) {
      projected.push({
        kind: "display.gap",
        correlationId,
        stream: "",
        text: displayGapMessage(dropped),
        payload: { dropped },
      });
    }
    if (kind === "model.reasoning_delta" && !this.showReasoning) {
      return projected;
    }
    if (
      this.foldToolOutput &&
      kind === "tool.output_delta" &&
      (stream || "stdout") === "stdout"
    ) {
      return projected;
    }

    // Lifecycle signals affect status even when they have no visible text.
    // Keep them in every audience projection so a display can never remain
    // stuck in a running state after delta traffic is coalesced.
    if (LIFECYCLE_EVENTS.has(kind) || kind.length > 0) {
      projected.push({ kind, correlationId, stream, text, payload });
    }
    return projected;
  }

  shouldQueue(event: DisplayEventLike | RuntimeEvent): boolean {
    return this.project(event).length > 0;
  }

  isHighFrequency(event: DisplayEventLike | RuntimeEvent): boolean {
    return HIGH_FREQUENCY_EVENTS.has(String(event.kind));
  }

  droppedCount(event: DisplayEventLike | RuntimeEvent): number {
    return droppedCount(asPayload(event.payload));
  }

  #correlationId(event: DisplayEventLike | RuntimeEvent): string {
    if ("correlation_id" in event && event.correlation_id !== undefined) {
      return String(event.correlation_id ?? "");
    }
    if ("correlationId" in event && event.correlationId !== undefined) {
      return String(event.correlationId ?? "");
    }
    return "";
  }
}
