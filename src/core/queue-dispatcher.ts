/** Queue placement policy for already-routed session actions. */

import {
  DeadLetterQueue,
  HeldQueue,
  PendingQueue,
  QueueOverflowError,
  type RoutedEvent,
} from "../routing.ts";
import type { SessionAction } from "./session-action.ts";

export const QueueDispatchStatus = {
  StartNow: "start_now",
  Pending: "pending",
  Held: "held",
  CancelNow: "cancel_now",
  DeadLetter: "dead_letter",
  Ignored: "ignored",
} as const;

export type QueueDispatchStatus =
  (typeof QueueDispatchStatus)[keyof typeof QueueDispatchStatus];

export interface QueueDispatchResult {
  readonly status: QueueDispatchStatus;
  readonly actionId: string;
  readonly position: number | null;
  readonly reason: string | null;
}

export type QueueRuntimeState = "idle" | "running" | "cancelling" | "stopped";

export interface QueueRuntimeSnapshot {
  readonly state: QueueRuntimeState;
}

export interface QueueDispatcherOptions {
  pending?: PendingQueue;
  held?: HeldQueue;
  deadLetters?: DeadLetterQueue;
}

/** Places user actions without changing the router's route decisions. */
export class QueueDispatcher {
  readonly pending: PendingQueue;
  readonly held: HeldQueue;
  readonly deadLetters: DeadLetterQueue;

  constructor(options: QueueDispatcherOptions = {}) {
    this.pending = options.pending ?? new PendingQueue();
    this.held = options.held ?? new HeldQueue();
    this.deadLetters = options.deadLetters ?? new DeadLetterQueue();
  }

  dispatch(
    action: SessionAction,
    snapshot: QueueRuntimeSnapshot,
    routed: RoutedEvent,
  ): QueueDispatchResult {
    if (routed.decision.destination === "drop") {
      this.deadLetters.put(routed.event, routed.decision.reason);
      return makeQueueDispatchResult(QueueDispatchStatus.DeadLetter, action.id, {
        reason: routed.decision.reason,
      });
    }
    if (
      routed.decision.destination === "held" &&
      routed.decision.timing === "after_cancel"
    ) {
      return this.enqueueHeld(action.id, routed);
    }

    const placement = this.placementFor(action, snapshot);
    if (placement === QueueDispatchStatus.StartNow) {
      return makeQueueDispatchResult(QueueDispatchStatus.StartNow, action.id);
    }
    if (placement === QueueDispatchStatus.Pending) {
      return this.enqueuePending(
        action.id,
        this.withPlacement(routed, "pending"),
      );
    }
    if (placement === QueueDispatchStatus.Held) {
      return this.enqueueHeld(
        action.id,
        this.withPlacement(routed, "held"),
      );
    }
    if (placement === QueueDispatchStatus.CancelNow) {
      return makeQueueDispatchResult(QueueDispatchStatus.CancelNow, action.id);
    }

    const destination = routed.decision.destination;
    if (destination === "new_task" && snapshot.state === "idle") {
      return makeQueueDispatchResult(QueueDispatchStatus.StartNow, action.id);
    }
    if (destination === "pending") {
      return this.enqueuePending(action.id, routed);
    }
    if (destination === "held") {
      return this.enqueueHeld(action.id, routed);
    }
    return makeQueueDispatchResult(QueueDispatchStatus.Ignored, action.id);
  }

  private placementFor(
    action: SessionAction,
    snapshot: QueueRuntimeSnapshot,
  ):
    | typeof QueueDispatchStatus.StartNow
    | typeof QueueDispatchStatus.Pending
    | typeof QueueDispatchStatus.Held
    | typeof QueueDispatchStatus.CancelNow
    | null {
    if (action.type === "cancel") {
      return QueueDispatchStatus.CancelNow;
    }
    if (action.type === "prompt" && snapshot.state === "idle") {
      return QueueDispatchStatus.StartNow;
    }
    if (
      snapshot.state === "running" &&
      (action.type === "steer" || action.type === "follow_up")
    ) {
      return QueueDispatchStatus.Pending;
    }
    if (action.type === "prompt" && snapshot.state === "cancelling") {
      return QueueDispatchStatus.Held;
    }
    return null;
  }

  /** Queue APIs validate destination; preserve all other router metadata. */
  private withPlacement(
    routed: RoutedEvent,
    destination: "pending" | "held",
  ): RoutedEvent {
    return {
      event: routed.event,
      decision: { ...routed.decision, destination },
    };
  }

  private enqueuePending(actionId: string, routed: RoutedEvent): QueueDispatchResult {
    try {
      this.pending.put(routed);
      return makeQueueDispatchResult(QueueDispatchStatus.Pending, actionId, {
        position: this.pending.size,
      });
    } catch (error) {
      return this.deadLetterOverflow(actionId, routed, error);
    }
  }

  private enqueueHeld(actionId: string, routed: RoutedEvent): QueueDispatchResult {
    try {
      this.held.put(routed);
      return makeQueueDispatchResult(QueueDispatchStatus.Held, actionId, {
        position: this.held.size,
      });
    } catch (error) {
      return this.deadLetterOverflow(actionId, routed, error);
    }
  }

  private deadLetterOverflow(
    actionId: string,
    routed: RoutedEvent,
    error: unknown,
  ): QueueDispatchResult {
    if (!(error instanceof QueueOverflowError)) {
      throw error;
    }
    this.deadLetters.put(routed.event, error.message);
    return makeQueueDispatchResult(QueueDispatchStatus.DeadLetter, actionId, {
      reason: error.message,
    });
  }
}

export function makeQueueDispatchResult(
  status: QueueDispatchStatus,
  actionId: string,
  options: { position?: number; reason?: string } = {},
): QueueDispatchResult {
  return {
    status,
    actionId,
    position: options.position ?? null,
    reason: options.reason ?? null,
  };
}
