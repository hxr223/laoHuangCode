import { CancelToken } from "../cancellation.ts";

export const SessionState = {
  Idle: "idle",
  Running: "running",
  Cancelling: "cancelling",
  Stopped: "stopped",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

export const TaskState = {
  Pending: "pending",
  Running: "running",
  Cancelling: "cancelling",
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

export interface TaskRecord {
  readonly taskId: string;
  readonly state: TaskState;
  readonly cancelToken: CancelToken;
  readonly result: string | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export function makeTaskRecord(
  taskId: string,
  options: {
    state?: TaskState;
    cancelToken?: CancelToken;
    startedAt?: number | null;
  } = {},
): TaskRecord {
  return {
    taskId,
    state: options.state ?? TaskState.Pending,
    cancelToken: options.cancelToken ?? new CancelToken(),
    result: null,
    error: null,
    startedAt: options.startedAt ?? null,
    finishedAt: null,
  };
}
