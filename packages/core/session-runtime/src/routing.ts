/** Deterministic routing and runtime input queues. */

import {
  EventKind,
  EventSource,
  type AnyEventEnvelope,
  type RouteDecision,
  type RouteDestination,
  type RoutedEvent,
  type RouteStrategy,
  type RouteTiming,
  type SemanticClassifier,
} from "@laohuang/runtime-protocol";
import {
  TaskState,
  isTerminalTaskState,
  type TaskRecord,
  type TaskRegistry,
} from "./core/task-lifecycle.ts";

export type {
  RouteDecision,
  RouteDestination,
  RoutedEvent,
  RouteStrategy,
  RouteTiming,
  SemanticClassifier,
  SemanticClassifierFn,
  SemanticClassifierObject,
  SemanticClassifierTask,
  SemanticClassifierVerdict,
} from "@laohuang/runtime-protocol";

// ---------------------------------------------------------------------------
// Token estimates
// ---------------------------------------------------------------------------

/** Provider-neutral conservative token estimate without a tokenizer. */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.floor((new TextEncoder().encode(text).length + 3) / 4));
}

function eventTokens(routed: RoutedEvent): number {
  const content = routed.event.payload["content"];
  return estimateTokens(
    typeof content === "string" ? content : String(content ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Dead-letter queue
// ---------------------------------------------------------------------------

export interface DeadLetter {
  readonly event: AnyEventEnvelope;
  readonly reason: string;
}

/** Bounded inspection queue for events rejected by routing or capacity. */
export class DeadLetterQueue {
  readonly maxItems: number;
  private items: DeadLetter[] = [];

  constructor(maxItems = 100) {
    if (maxItems <= 0) {
      throw new RangeError("maxItems must be positive");
    }
    this.maxItems = maxItems;
  }

  put(event: AnyEventEnvelope, reason: string): void {
    if (this.items.length >= this.maxItems) {
      this.items.shift();
    }
    this.items.push({ event, reason });
  }

  drain(): DeadLetter[] {
    const items = this.items;
    this.items = [];
    return items;
  }

  snapshot(): DeadLetter[] {
    return [...this.items];
  }

  clear(): number {
    return this.drain().length;
  }

  get size(): number {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// Four-layer router
// ---------------------------------------------------------------------------

export type SafetyPolicy = (
  event: AnyEventEnvelope,
  decision: RouteDecision,
) => RouteDecision | boolean | null | undefined;

export interface EventRouterOptions {
  semanticClassifier?: SemanticClassifier | null;
  safetyPolicy?: SafetyPolicy | null;
}

function isRouteDecision(verdict: unknown): verdict is RouteDecision {
  return typeof verdict === "object" && verdict !== null;
}

/**
 * Four-layer router with deterministic safety as the final arbiter.
 *
 * Layers one through three short-circuit after obtaining a decision. Layer
 * four always runs, so an injected semantic classifier can never override
 * cancellation, invalid task ownership, or a custom safety policy.
 */
export class EventRouter {
  readonly taskRegistry: TaskRegistry;
  private readonly semanticClassifier: SemanticClassifier | null;
  private readonly safetyPolicy: SafetyPolicy | null;

  constructor(taskRegistry: TaskRegistry, options: EventRouterOptions = {}) {
    this.taskRegistry = taskRegistry;
    this.semanticClassifier = options.semanticClassifier ?? null;
    this.safetyPolicy = options.safetyPolicy ?? null;
  }

  async route(event: AnyEventEnvelope): Promise<RoutedEvent> {
    const active = this.taskRegistry.active();
    let decision =
      this.metadataMatch(event, active) ??
      this.deterministicRules(event, active) ??
      (await this.semanticClassification(event, active)) ??
      EventRouter.defaultDecision(event, active);
    decision = this.safetyArbiter(event, active, decision);
    return { event, decision };
  }

  private metadataMatch(
    event: AnyEventEnvelope,
    active: TaskRecord | null,
  ): RouteDecision | null {
    if (event.task_id === null) {
      return null;
    }
    const target = this.taskRegistry.get(event.task_id);
    if (target === null) {
      return {
        taskId: event.task_id,
        destination: "drop",
        timing: "immediate",
        strategy: "reject",
        confidence: 1.0,
        reason: "metadata references an unknown task",
        layer: 1,
      };
    }
    if (event.source !== EventSource.User && event.source !== EventSource.Cli) {
      if (
        active === null ||
        target.taskId !== active.taskId ||
        isTerminalTaskState(target.state)
      ) {
        return {
          taskId: target.taskId,
          destination: "drop",
          timing: "immediate",
          strategy: "reject",
          confidence: 1.0,
          reason: "stale internal callback targeted an inactive task",
          layer: 1,
        };
      }
      return {
        taskId: target.taskId,
        destination: "current_task",
        timing: "immediate",
        strategy: "execute",
        confidence: 1.0,
        reason: "internal callback matched task metadata",
        layer: 1,
      };
    }
    if (active !== null && target.taskId === active.taskId) {
      const held = active.state === TaskState.Cancelling;
      return {
        taskId: target.taskId,
        destination: held ? "held" : "pending",
        timing: held ? "after_cancel" : "safe_point",
        strategy: "steer",
        confidence: 1.0,
        reason: "user input explicitly matched the active task",
        layer: 1,
      };
    }
    return {
      taskId: target.taskId,
      destination: "held",
      timing: "after_cancel",
      strategy: "follow_up",
      confidence: 1.0,
      reason: "user input targets an inactive task",
      layer: 1,
    };
  }

  private deterministicRules(
    event: AnyEventEnvelope,
    active: TaskRecord | null,
  ): RouteDecision | null {
    const rawContent = event.payload["content"];
    const content = String(rawContent ?? "").trim();
    if (
      event.kind === EventKind.InputCancelRequested ||
      content === "/cancel"
    ) {
      return {
        taskId: active?.taskId ?? null,
        destination: "control",
        timing: "immediate",
        strategy: "cancel",
        confidence: 1.0,
        reason: "cancel is an immediate control event",
        layer: 2,
      };
    }
    if (event.kind === EventKind.InputSlashCommand) {
      return {
        taskId: active?.taskId ?? null,
        destination: "control",
        timing: "immediate",
        strategy: "execute",
        confidence: 1.0,
        reason: "slash commands are deterministic local control input",
        layer: 2,
      };
    }
    if (event.kind !== EventKind.InputReceived) {
      return {
        taskId: event.task_id || active?.taskId || null,
        destination: "current_task",
        timing: "immediate",
        strategy: "execute",
        confidence: 1.0,
        reason: "non-input event follows deterministic callback routing",
        layer: 2,
      };
    }
    if (active === null) {
      return {
        taskId: null,
        destination: "new_task",
        timing: "immediate",
        strategy: "execute",
        confidence: 1.0,
        reason: "no active task",
        layer: 2,
      };
    }
    if (active.state === TaskState.Cancelling) {
      return {
        taskId: active.taskId,
        destination: "held",
        timing: "after_cancel",
        strategy: "follow_up",
        confidence: 1.0,
        reason: "ordinary input is held while cancellation settles",
        layer: 2,
      };
    }
    const requested = event.payload["strategy"];
    if (requested === "steer") {
      return {
        taskId: active.taskId,
        destination: "pending",
        timing: "safe_point",
        strategy: "steer",
        confidence: 1.0,
        reason: "explicit steering strategy",
        layer: 2,
      };
    }
    if (requested === "follow_up") {
      return {
        taskId: active.taskId,
        destination: "pending",
        timing: "safe_point",
        strategy: "follow_up",
        confidence: 1.0,
        reason: "explicit follow-up strategy",
        layer: 2,
      };
    }
    return null;
  }

  private async semanticClassification(
    event: AnyEventEnvelope,
    active: TaskRecord | null,
  ): Promise<RouteDecision | null> {
    if (this.semanticClassifier === null || active === null) {
      return null;
    }
    const classifier = this.semanticClassifier;
    const classified =
      typeof classifier === "function"
        ? await classifier(event, active)
        : await classifier.classify(event, active);
    if (classified === null || classified === undefined) {
      return null;
    }
    if (isRouteDecision(classified)) {
      return classified;
    }
    const strategy = String(classified);
    if (strategy !== "steer" && strategy !== "follow_up") {
      return null;
    }
    return {
      taskId: active.taskId,
      destination: "pending",
      timing: "safe_point",
      strategy,
      confidence: 0.75,
      reason: "semantic classifier resolved ambiguous input",
      layer: 3,
    };
  }

  private static defaultDecision(
    event: AnyEventEnvelope,
    active: TaskRecord | null,
  ): RouteDecision {
    if (active === null) {
      return {
        taskId: null,
        destination: "new_task",
        timing: "immediate",
        strategy: "execute",
        confidence: 0.5,
        reason: "defaulted to a new task",
        layer: 3,
      };
    }
    return {
      taskId: active.taskId,
      destination: "pending",
      timing: "safe_point",
      strategy: "follow_up",
      confidence: 0.5,
      reason: "ambiguous input defaults to a safe follow-up",
      layer: 3,
    };
  }

  private safetyArbiter(
    event: AnyEventEnvelope,
    active: TaskRecord | null,
    decision: RouteDecision,
  ): RouteDecision {
    let current = decision;
    if (this.safetyPolicy !== null) {
      const verdict = this.safetyPolicy(event, current);
      if (isRouteDecision(verdict)) {
        current = verdict;
      } else if (verdict === false) {
        current = {
          taskId: current.taskId,
          destination: "drop",
          timing: "immediate",
          strategy: "reject",
          confidence: 1.0,
          reason: "custom safety policy rejected the event",
          layer: 4,
        };
      }
    }

    // These invariants run after the custom policy, so neither a classifier
    // nor a policy callback can downgrade cancellation or target an unknown
    // task.
    if (event.kind === EventKind.InputCancelRequested) {
      return {
        taskId: active?.taskId ?? null,
        destination: "control",
        timing: "immediate",
        strategy: "cancel",
        confidence: 1.0,
        reason: "safety arbiter preserves immediate cancellation",
        layer: 4,
      };
    }
    if (
      current.taskId !== null &&
      this.taskRegistry.get(current.taskId) === null &&
      current.destination !== "new_task"
    ) {
      return {
        taskId: current.taskId,
        destination: "drop",
        timing: "immediate",
        strategy: "reject",
        confidence: 1.0,
        reason: "safety arbiter rejected an unknown task",
        layer: 4,
      };
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Bounded runtime queues
// ---------------------------------------------------------------------------

/** Raised when a bounded queue exceeds its item or token budget. */
export class QueueOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueOverflowError";
  }
}

export interface BoundedQueueOptions {
  maxEstimatedTokens?: number;
}

function compatibilityKey(routed: RoutedEvent): string {
  return JSON.stringify([routed.event.session_id, routed.decision.taskId]);
}

export interface DrainCompatibleOptions {
  taskId?: string | null;
  strategy?: RouteStrategy | null;
  timing?: RouteTiming | null;
}

/** FIFO queue with atomic compatible-batch snapshots. */
export class PendingQueue {
  readonly maxItems: number;
  readonly maxEstimatedTokens: number;
  private items: RoutedEvent[] = [];
  private estimatedTokensValue = 0;

  constructor(maxItems = 100, options: BoundedQueueOptions = {}) {
    const maxEstimatedTokens = options.maxEstimatedTokens ?? 8_000;
    if (maxItems <= 0) {
      throw new RangeError("maxItems must be positive");
    }
    if (maxEstimatedTokens <= 0) {
      throw new RangeError("maxEstimatedTokens must be positive");
    }
    this.maxItems = maxItems;
    this.maxEstimatedTokens = maxEstimatedTokens;
  }

  put(event: RoutedEvent): void {
    if (event.decision.destination !== "pending") {
      throw new Error("PendingQueue only accepts pending events");
    }
    if (this.items.length >= this.maxItems) {
      throw new QueueOverflowError("pending queue is full");
    }
    const tokens = eventTokens(event);
    if (this.estimatedTokensValue + tokens > this.maxEstimatedTokens) {
      throw new QueueOverflowError("pending queue token budget is full");
    }
    this.items.push(event);
    this.estimatedTokensValue += tokens;
  }

  promoteFirstCompatible(options: DrainCompatibleOptions = {}): RoutedEvent | null {
    const taskId = options.taskId ?? null;
    const strategy = options.strategy ?? null;
    const timing = options.timing ?? null;
    const index = this.items.findIndex((item) => {
      if (taskId !== null && item.decision.taskId !== taskId) {
        return false;
      }
      if (strategy !== null && item.decision.strategy !== strategy) {
        return false;
      }
      if (timing !== null && item.decision.timing !== timing) {
        return false;
      }
      return true;
    });
    if (index === -1) {
      return null;
    }
    const item = this.items[index]!;
    const promoted: RoutedEvent = {
      event: item.event,
      decision: {
        ...item.decision,
        destination: "pending",
        timing: "safe_point",
        strategy: "steer",
        confidence: 1.0,
        reason: "promoted to steer by user",
        layer: 4,
      },
    };
    this.items[index] = promoted;
    return promoted;
  }

  /** Atomically remove all currently eligible events in source order. */
  drainCompatible(options: DrainCompatibleOptions = {}): RoutedEvent[] {
    const taskId = options.taskId ?? null;
    const strategy = options.strategy ?? null;
    const timing = options.timing ?? null;
    if (this.items.length === 0) {
      return [];
    }
    const pivot = this.items.find(
      (item) => taskId === null || item.decision.taskId === taskId,
    );
    if (pivot === undefined) {
      return [];
    }
    const key = compatibilityKey(pivot);
    const drained: RoutedEvent[] = [];
    const retained: RoutedEvent[] = [];
    for (const item of this.items) {
      let compatible = compatibilityKey(item) === key;
      if (strategy !== null) {
        compatible = compatible && item.decision.strategy === strategy;
      }
      if (timing !== null) {
        compatible = compatible && item.decision.timing === timing;
      }
      if (compatible) {
        drained.push(item);
      } else {
        retained.push(item);
      }
    }
    this.items = retained;
    this.estimatedTokensValue = retained.reduce(
      (sum, item) => sum + eventTokens(item),
      0,
    );
    return drained;
  }

  /** Atomically remove every strategy bucket belonging to a task. */
  drainTask(taskId: string): RoutedEvent[] {
    const drained: RoutedEvent[] = [];
    const retained: RoutedEvent[] = [];
    for (const item of this.items) {
      if (item.decision.taskId === taskId) {
        drained.push(item);
      } else {
        retained.push(item);
      }
    }
    this.items = retained;
    this.estimatedTokensValue = retained.reduce(
      (sum, item) => sum + eventTokens(item),
      0,
    );
    return drained;
  }

  get estimatedTokens(): number {
    return this.estimatedTokensValue;
  }

  snapshot(): RoutedEvent[] {
    return [...this.items];
  }

  clear(): number {
    const count = this.items.length;
    this.items = [];
    this.estimatedTokensValue = 0;
    return count;
  }

  get size(): number {
    return this.items.length;
  }
}

export interface DrainHeldOptions {
  taskId?: string | null;
}

/** Inputs retained while the active task is cancelling. */
export class HeldQueue {
  readonly maxItems: number;
  readonly maxEstimatedTokens: number;
  private items: RoutedEvent[] = [];
  private estimatedTokensValue = 0;

  constructor(maxItems = 100, options: BoundedQueueOptions = {}) {
    const maxEstimatedTokens = options.maxEstimatedTokens ?? 8_000;
    if (maxItems <= 0) {
      throw new RangeError("maxItems must be positive");
    }
    if (maxEstimatedTokens <= 0) {
      throw new RangeError("maxEstimatedTokens must be positive");
    }
    this.maxItems = maxItems;
    this.maxEstimatedTokens = maxEstimatedTokens;
  }

  put(event: RoutedEvent): void {
    if (event.decision.destination !== "held") {
      throw new Error("HeldQueue only accepts held events");
    }
    if (this.items.length >= this.maxItems) {
      throw new QueueOverflowError("held queue is full");
    }
    const tokens = eventTokens(event);
    if (this.estimatedTokensValue + tokens > this.maxEstimatedTokens) {
      throw new QueueOverflowError("held queue token budget is full");
    }
    this.items.push(event);
    this.estimatedTokensValue += tokens;
  }

  drain(options: DrainHeldOptions = {}): RoutedEvent[] {
    const taskId = options.taskId ?? null;
    if (taskId === null) {
      const items = this.items;
      this.items = [];
      this.estimatedTokensValue = 0;
      return items;
    }
    const drained: RoutedEvent[] = [];
    const retained: RoutedEvent[] = [];
    for (const item of this.items) {
      if (item.decision.taskId === taskId) {
        drained.push(item);
      } else {
        retained.push(item);
      }
    }
    this.items = retained;
    this.estimatedTokensValue = retained.reduce(
      (sum, item) => sum + eventTokens(item),
      0,
    );
    return drained;
  }

  get estimatedTokens(): number {
    return this.estimatedTokensValue;
  }

  clear(): number {
    return this.drain().length;
  }

  get size(): number {
    return this.items.length;
  }
}

/** Combine a pending snapshot into one model input without losing IDs. */
export function combineInput(events: Iterable<RoutedEvent>): string {
  const parts: string[] = [];
  for (const item of events) {
    const raw = item.event.payload["content"];
    const content = String(raw ?? "").trim();
    if (content) {
      parts.push(`[event_id=${item.event.event_id}]\n${content}`);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return (
    "Please handle all of these pending messages in one response:\n\n" +
    parts.join("\n\n")
  );
}
