/** Audience-specific policy for converting runtime events into display events. */

import type { RuntimeEvent } from "../runtime/runtime-events.ts";

export type DisplayAudience = "terminal" | "web";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function droppedCount(payload: Record<string, unknown>): number {
  const value = payload._projection_dropped;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

/**
 * Projects canonical EventEnvelope-shaped events and RuntimeEvent-shaped
 * values. Runtime events use camelCase task metadata, while terminal/web
 * event envelopes retain their existing snake_case metadata.
 */
export class DisplayPolicy {
  readonly audience: DisplayAudience;
  readonly showReasoning: boolean;

  constructor(options: DisplayPolicyOptions) {
    this.audience = options.audience;
    this.showReasoning = options.showReasoning ?? true;
  }

  project(event: DisplayEventLike | RuntimeEvent): DisplayEvent[] {
    const kind = String(event.kind);
    const payload = asPayload(event.payload);
    const correlationId = this.#correlationId(event);
    const stream = String(payload.stream ?? "");
    const text = String(payload.text ?? payload.chunk ?? "");
    const projected: DisplayEvent[] = [];
    const dropped = droppedCount(payload);

    if (dropped > 0) {
      projected.push({
        kind: "display.gap",
        correlationId,
        stream: "",
        text: `… 省略了 ${dropped} 个流式展示事件；Agent 仍继续运行。`,
        payload: { dropped },
      });
    }
    if (kind === "model.reasoning_delta" && !this.showReasoning) {
      return projected;
    }
    if (
      this.audience === "terminal" &&
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
