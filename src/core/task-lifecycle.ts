import { CancelToken } from "../cancellation.ts";
import { EventKind, EventSource, type EventBus } from "../events.ts";

export const TaskState = {
  RunningModel: "running_model",
  RunningTools: "running_tools",
  Cancelling: "cancelling",
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
} as const;

export type TaskState = (typeof TaskState)[keyof typeof TaskState];

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.Cancelled,
  TaskState.Completed,
  TaskState.Failed,
]);

const ALLOWED_TASK_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> =
  new Map([
    [
      TaskState.RunningModel,
      new Set([
        TaskState.RunningTools,
        TaskState.Cancelling,
        TaskState.Completed,
        TaskState.Failed,
      ]),
    ],
    [
      TaskState.RunningTools,
      new Set([
        TaskState.RunningModel,
        TaskState.Cancelling,
        TaskState.Completed,
        TaskState.Failed,
      ]),
    ],
    [TaskState.Cancelling, new Set([TaskState.Cancelled])],
    [TaskState.Cancelled, new Set()],
    [TaskState.Completed, new Set()],
    [TaskState.Failed, new Set()],
  ]);

export interface TaskRecord {
  readonly taskId: string;
  readonly state: TaskState;
  readonly cancelToken: CancelToken;
  readonly result: string | null;
  readonly error: string | null;
}

export interface RegisterTaskOptions {
  state?: TaskState;
  cancelToken?: CancelToken;
  activate?: boolean;
}

export interface TransitionOptions {
  result?: string;
  error?: string;
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

/** Task records with at most one active task. */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>();
  private activeTaskIdValue: string | null = null;

  get activeTaskId(): string | null {
    return this.activeTaskIdValue;
  }

  register(taskId: string, options: RegisterTaskOptions = {}): TaskRecord {
    const state = options.state ?? TaskState.RunningModel;
    const activate = options.activate ?? true;
    if (this.tasks.has(taskId)) {
      throw new Error(`task already exists: ${taskId}`);
    }
    if (activate && this.activeTaskIdValue !== null) {
      throw new Error("another task is already active");
    }
    const record: TaskRecord = {
      taskId,
      state,
      cancelToken: options.cancelToken ?? new CancelToken(),
      result: null,
      error: null,
    };
    this.tasks.set(taskId, record);
    if (activate && !isTerminalTaskState(state)) {
      this.activeTaskIdValue = taskId;
    }
    return { ...record };
  }

  get(taskId: string): TaskRecord | null {
    const record = this.tasks.get(taskId);
    return record === undefined ? null : { ...record };
  }

  active(): TaskRecord | null {
    if (this.activeTaskIdValue === null) {
      return null;
    }
    const record = this.tasks.get(this.activeTaskIdValue);
    return record === undefined ? null : { ...record };
  }

  transition(
    taskId: string,
    state: TaskState,
    options: TransitionOptions = {},
  ): TaskRecord {
    const record = this.tasks.get(taskId);
    if (record === undefined) {
      throw new Error(`unknown task: ${taskId}`);
    }
    if (
      state !== record.state &&
      !ALLOWED_TASK_TRANSITIONS.get(record.state)?.has(state)
    ) {
      throw new Error(`invalid task transition: ${record.state} -> ${state}`);
    }
    const next: TaskRecord = {
      ...record,
      state,
      result: options.result !== undefined ? options.result : record.result,
      error: options.error !== undefined ? options.error : record.error,
    };
    if (isTerminalTaskState(state)) {
      if (this.activeTaskIdValue === taskId) {
        this.activeTaskIdValue = null;
      }
    } else {
      const active = this.activeTaskIdValue;
      if (active !== null && active !== taskId) {
        throw new Error("another task is already active");
      }
      this.activeTaskIdValue = taskId;
    }
    this.tasks.set(taskId, next);
    return { ...next };
  }

  records(): TaskRecord[] {
    return [...this.tasks.values()].map((record) => ({ ...record }));
  }
}

export interface TaskLifecycleOptions {
  readonly eventBus: EventBus;
  readonly sessionId: string;
  readonly taskRegistry?: TaskRegistry;
  readonly queueCounts?: () => { readonly pending: number; readonly held: number };
  readonly onCancelling?: (taskId: string) => void;
}

export interface CreateTaskOptions {
  readonly cancelToken?: CancelToken;
  readonly correlationId?: string | null;
}

/** Owns task state changes and their canonical lifecycle events. */
export class TaskLifecycle {
  readonly taskRegistry: TaskRegistry;
  private readonly eventBus: EventBus;
  private readonly sessionId: string;
  private readonly queueCounts: () => {
    readonly pending: number;
    readonly held: number;
  };
  private readonly onCancelling: (taskId: string) => void;

  constructor(options: TaskLifecycleOptions) {
    this.eventBus = options.eventBus;
    this.sessionId = options.sessionId;
    this.taskRegistry = options.taskRegistry ?? new TaskRegistry();
    this.queueCounts = options.queueCounts ?? (() => ({ pending: 0, held: 0 }));
    this.onCancelling = options.onCancelling ?? (() => {});
  }

  active(): TaskRecord | null {
    return this.taskRegistry.active();
  }

  createTask(taskId: string, options: CreateTaskOptions = {}): TaskRecord {
    const record = this.taskRegistry.register(taskId, {
      cancelToken: options.cancelToken,
    });
    const counts = this.queueCounts();
    this.eventBus.publish(EventKind.TaskStarted, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      correlation_id: options.correlationId ?? null,
      payload: {
        pending_count: counts.pending,
        held_count: counts.held,
      },
    });
    return record;
  }

  markModelRunning(taskId: string): boolean {
    return this.markRunning(taskId, TaskState.RunningModel);
  }

  markToolsRunning(taskId: string): boolean {
    return this.markRunning(taskId, TaskState.RunningTools);
  }

  requestCancel(taskId: string, reason = "cancelled by user"): boolean {
    const record = this.taskRegistry.get(taskId);
    if (record === null || isTerminalTaskState(record.state)) {
      return false;
    }
    if (record.state === TaskState.Cancelling) {
      return true;
    }
    this.taskRegistry.transition(taskId, TaskState.Cancelling);
    this.onCancelling(taskId);
    this.publishState(taskId, TaskState.Cancelling);
    return record.cancelToken.cancel(reason);
  }

  completeTask(taskId: string, result: string | null): boolean {
    const record = this.taskRegistry.get(taskId);
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      isTerminalTaskState(record.state)
    ) {
      return false;
    }
    this.taskRegistry.transition(
      taskId,
      TaskState.Completed,
      result === null ? {} : { result },
    );
    const counts = this.queueCounts();
    this.eventBus.publish(EventKind.TaskCompleted, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      payload: {
        result: result ?? "",
        pending_count: counts.pending,
        held_count: counts.held,
      },
    });
    return true;
  }

  finishCancelled(taskId: string): boolean {
    const record = this.taskRegistry.get(taskId);
    if (record === null || record.state !== TaskState.Cancelling) {
      return false;
    }
    this.taskRegistry.transition(taskId, TaskState.Cancelled);
    const counts = this.queueCounts();
    this.eventBus.publish(EventKind.TaskCancelled, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      payload: {
        reason: record.cancelToken.reason ?? "cancelled",
        pending_count: counts.pending,
        held_count: counts.held,
      },
    });
    return true;
  }

  failTask(taskId: string, error: string): boolean {
    const record = this.taskRegistry.get(taskId);
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      isTerminalTaskState(record.state)
    ) {
      return false;
    }
    this.taskRegistry.transition(taskId, TaskState.Failed, { error });
    const counts = this.queueCounts();
    this.eventBus.publish(EventKind.TaskFailed, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      payload: {
        error,
        pending_count: counts.pending,
        held_count: counts.held,
      },
    });
    return true;
  }

  publishCurrentState(taskId: string): boolean {
    const record = this.taskRegistry.get(taskId);
    if (record === null) {
      return false;
    }
    this.publishState(taskId, record.state);
    return true;
  }

  private markRunning(taskId: string, state: TaskState): boolean {
    const record = this.taskRegistry.get(taskId);
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      isTerminalTaskState(record.state)
    ) {
      return false;
    }
    if (record.state !== state) {
      this.taskRegistry.transition(taskId, state);
      this.publishState(taskId, state);
    }
    return true;
  }

  private publishState(taskId: string, state: TaskState): void {
    const counts = this.queueCounts();
    this.eventBus.publish(EventKind.TaskStateChanged, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      payload: {
        state,
        state_name: state.toUpperCase(),
        pending_count: counts.pending,
        held_count: counts.held,
      },
    });
  }
}
