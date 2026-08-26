/** Runtime event contracts shared by producers and projections. */

import { randomUUID } from "node:crypto";

export const RuntimeEventKind = {
  ActionReceived: "action.received",
  TaskStarted: "task.started",
  TaskStateChanged: "task.state_changed",
  TaskCompleted: "task.completed",
  TaskFailed: "task.failed",
  TaskCancelled: "task.cancelled",
  Display: "display.action",
} as const;

export type RuntimeEventKind =
  (typeof RuntimeEventKind)[keyof typeof RuntimeEventKind];

/** Model-stream event names forwarded through the runtime boundary. */
export type ModelRuntimeEventType =
  | "model_text_delta"
  | "model_reasoning_delta"
  | "model_tool_call_delta"
  | "model_retry_scheduled"
  | "model_response_validating";

export type ModelRuntimeEventHandler = (
  eventType: ModelRuntimeEventType,
  payload: Record<string, unknown>,
) => void;

export interface RuntimeEvent<
  K extends RuntimeEventKind = RuntimeEventKind,
  P = unknown,
> {
  readonly id: string;
  readonly kind: K;
  readonly timestamp: number;
  readonly taskId: string | null;
  readonly payload: P;
}

export function makeRuntimeEvent<K extends RuntimeEventKind, P>(
  kind: K,
  payload: P,
  options: { id?: string; taskId?: string | null; timestamp?: number } = {},
): RuntimeEvent<K, P> {
  return {
    id: options.id ?? `event_${randomUUID()}`,
    kind,
    timestamp: options.timestamp ?? Date.now(),
    taskId: options.taskId ?? null,
    payload,
  };
}
