/** Results returned when a session action is offered to a queue. */

export const QueueDispatchStatus = {
  Queued: "queued",
  Held: "held",
  Rejected: "rejected",
} as const;

export type QueueDispatchStatus =
  (typeof QueueDispatchStatus)[keyof typeof QueueDispatchStatus];

export interface QueueDispatchResult {
  readonly status: QueueDispatchStatus;
  readonly actionId: string;
  readonly position: number | null;
  readonly reason: string | null;
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
