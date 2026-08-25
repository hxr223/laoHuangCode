import type { AnyEventEnvelope } from "./events.ts";

export type RouteStrategy =
  | "execute"
  | "steer"
  | "follow_up"
  | "cancel"
  | "reject";

export type RouteDestination =
  | "new_task"
  | "current_task"
  | "pending"
  | "held"
  | "control"
  | "drop";

export type RouteTiming = "immediate" | "safe_point" | "after_cancel";

export interface RouteDecision {
  readonly taskId: string | null;
  readonly destination: RouteDestination;
  readonly timing: RouteTiming;
  readonly strategy: RouteStrategy;
  readonly confidence: number;
  readonly reason: string;
  readonly layer: number;
}

export interface RoutedEvent {
  readonly event: AnyEventEnvelope;
  readonly decision: RouteDecision;
}

export interface SemanticClassifierTask {
  readonly taskId: string;
  readonly state: string;
}

export type SemanticClassifierVerdict =
  | RouteDecision
  | RouteStrategy
  | (string & {})
  | boolean
  | null
  | undefined;

export type SemanticClassifierFn = (
  event: AnyEventEnvelope,
  active: SemanticClassifierTask | null,
) => SemanticClassifierVerdict | Promise<SemanticClassifierVerdict>;

export interface SemanticClassifierObject {
  classify(
    event: AnyEventEnvelope,
    active: SemanticClassifierTask | null,
  ): RouteDecision | null | Promise<RouteDecision | null>;
}

export type SemanticClassifier =
  | SemanticClassifierFn
  | SemanticClassifierObject;
