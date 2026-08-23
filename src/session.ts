/** Single-active-task runtime coordination for laoHuangCode. */

import { randomUUID } from "node:crypto";

import { CancellationError, type CancelToken } from "./cancellation.ts";
import type { CodingAgent } from "./agent.ts";
import type { QueueStatus } from "./commands.ts";
import {
  EventBus,
  EventKind,
  EventSource,
  type AnyEventEnvelope,
  type EventEnvelope,
} from "./events.ts";
import {
  DeadLetterQueue,
  EventRouter,
  HeldQueue,
  PendingQueue,
  QueueOverflowError,
  Scheduler,
  TaskRegistry,
  TaskState,
  combineInput,
  type RouteDecision,
  type RoutedEvent,
  type SafetyPolicy,
  type SemanticClassifier,
  type TaskRecord,
} from "./routing.ts";
import type { SessionAction } from "./runtime/session-action.ts";

export const SessionState = {
  Idle: "idle",
  Running: "running",
  Cancelling: "cancelling",
  Stopped: "stopped",
} as const;

export type SessionState = (typeof SessionState)[keyof typeof SessionState];

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.Cancelled,
  TaskState.Completed,
  TaskState.Failed,
]);

const ROUTE_STRATEGIES: ReadonlySet<string> = new Set([
  "execute",
  "steer",
  "follow_up",
  "cancel",
  "reject",
]);

/** One compatible batch of pending input claimed at a safe point. */
export interface PendingInputBatch {
  readonly events: readonly RoutedEvent[];
  readonly content: string;
  readonly eventIds: readonly string[];
}

function makeBatch(events: readonly RoutedEvent[]): PendingInputBatch {
  return {
    events,
    content: combineInput(events),
    eventIds: events.map((item) => item.event.event_id),
  };
}

const EMPTY_BATCH: PendingInputBatch = {
  events: [],
  content: "",
  eventIds: [],
};

/** Outcome of one {@link AgentSession.submitInput} call. */
export interface Submission {
  readonly event: AnyEventEnvelope;
  readonly routed: RoutedEvent;
  readonly taskId: string | null;
  readonly queued: boolean;
  readonly control: boolean;
  readonly rejected: boolean;
  readonly reason: string;
}

export type TaskRunnerResult = string | null | Promise<string | null>;

/**
 * Structural contract for the model/tool worker: CodingAgent (agent.ts)
 * satisfies it — `run(userInput, context, options?)` takes the TaskContext as
 * its second argument and resolves to the final assistant text (or null).
 */
export interface AgentRunnerLike {
  run(userInput: string, context: TaskContext): TaskRunnerResult;
}

export type TaskRunner =
  | ((content: string, context: TaskContext) => TaskRunnerResult)
  | AgentRunnerLike;

export type CommandDispatcher = (
  command: string,
) => boolean | Promise<boolean>;

// Compile-time contract check (tsc covers src/ only): the real CodingAgent
// from agent.ts is a valid AgentRunnerLike — its run(userInput, context,
// options?) accepts this module's TaskContext, whose publish options use the
// events.ts snake_case convention (correlation_id) that agent.ts emits.
type AssertCodingAgentIsRunner =
  CodingAgent extends AgentRunnerLike ? true : never;
const assertCodingAgentIsRunner: AssertCodingAgentIsRunner = true;
void assertCodingAgentIsRunner;

function sameEventIds(
  inflight: readonly RoutedEvent[],
  eventIds: readonly string[],
): boolean {
  if (inflight.length !== eventIds.length) {
    return false;
  }
  return inflight.every((item, index) => item.event.event_id === eventIds[index]);
}

/** Capabilities exposed to one model/tool worker invocation. */
export class TaskContext {
  readonly sessionId: string;
  readonly taskId: string;
  readonly #session: AgentSession;
  #claimedInputEventIds: readonly string[] = [];

  constructor(session: AgentSession, taskId: string) {
    this.#session = session;
    this.sessionId = session.sessionId;
    this.taskId = taskId;
  }

  get cancelToken(): CancelToken {
    const record = this.#session.taskRegistry.get(this.taskId);
    if (record === null) {
      throw new Error(`task no longer exists: ${this.taskId}`);
    }
    return record.cancelToken;
  }

  get eventBus(): EventBus {
    return this.#session.eventBus;
  }

  isActive(): boolean {
    return this.#session.isTaskActive(this.taskId);
  }

  /**
   * Normalize and route a model/tool callback before fan-out. Await it to
   * preserve canonical ordering: the routing decision is published before the
   * event itself. Option names follow the events.ts EventBus.publish
   * convention (snake_case), matching agent.ts's AgentContext.publish.
   */
  publish(
    kind: string,
    options: {
      source: EventSource | string;
      correlation_id?: string | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<AnyEventEnvelope> {
    return this.#session.publishInternalEvent(kind, {
      source: options.source,
      taskId: this.taskId,
      correlationId: options.correlation_id ?? null,
      payload: options.payload,
    });
  }

  setState(state: TaskState): boolean {
    return this.#session.setRunningState(this.taskId, state);
  }

  modelStarted(): boolean {
    return this.setState(TaskState.RunningModel);
  }

  /** Acknowledge claimed input only once the SDK opened its request. */
  modelRequestOpened(): boolean {
    const acknowledged = this.#session.ackClaimedInput(
      this.taskId,
      this.#claimedInputEventIds,
    );
    if (acknowledged) {
      this.#claimedInputEventIds = [];
    }
    return acknowledged;
  }

  toolsStarted(): boolean {
    return this.setState(TaskState.RunningTools);
  }

  /** Atomically take one compatible pending batch for this task. */
  safePoint(): PendingInputBatch {
    return this.#session.drainPending(this.taskId);
  }

  /** @internal Used by the session worker around each runner invocation. */
  setClaimedInput(batch: PendingInputBatch | null): void {
    this.#claimedInputEventIds = batch === null ? [] : batch.eventIds;
  }

  commitInput(callback: () => void, rollback: () => void = () => {}): boolean {
    return this.#session.commitClaimedInput(
      this.taskId,
      this.#claimedInputEventIds,
      callback,
      rollback,
    );
  }

  commitPending(
    batch: PendingInputBatch,
    callback: () => void,
    rollback: () => void = () => {},
  ): boolean {
    const committed = this.#session.commitClaimedInput(
      this.taskId,
      batch.eventIds,
      callback,
      rollback,
    );
    if (committed) {
      this.#claimedInputEventIds = batch.eventIds;
    }
    return committed;
  }

  /** Atomically reject history commits once cancellation has won. */
  commitIfActive(callback: () => void): boolean {
    return this.#session.commitIfActive(this.taskId, callback);
  }
}

export interface AgentSessionOptions {
  sessionId?: string;
  eventBus?: EventBus;
  taskRegistry?: TaskRegistry;
  semanticClassifier?: SemanticClassifier | null;
  safetyPolicy?: SafetyPolicy | null;
  commandDispatcher?: CommandDispatcher | null;
}

export interface CloseOptions {
  wait?: boolean;
  timeoutMs?: number;
}

/**
 * Owns runtime coordination while the CodingAgent owns model/tool logic.
 *
 * The Python original coordinates worker threads with locks; here every
 * critical section is synchronous, so atomicity comes from the event loop.
 * The only yield points are routing (semantic classification may be a network
 * call) and awaiting the runner, mirroring the spots where Python released
 * its coordination lock.
 */
export class AgentSession {
  readonly sessionId: string;
  readonly eventBus: EventBus;
  readonly taskRegistry: TaskRegistry;
  readonly pending: PendingQueue;
  readonly held: HeldQueue;
  readonly deadLetters: DeadLetterQueue;
  readonly scheduler: Scheduler;
  readonly router: EventRouter;
  readonly runner: TaskRunner;
  readonly #commandDispatcher: CommandDispatcher | null;

  #state: SessionState = SessionState.Idle;
  #worker: object | null = null;
  #workerActive = false;
  #closeRequested = false;
  #inflightPending = new Map<string, readonly RoutedEvent[]>();
  #inflightRollbacks = new Map<string, () => void>();
  #idle = true;
  #idleWaiters = new Set<() => void>();
  #finalizePromise: Promise<void> | null = null;

  constructor(runner: TaskRunner, options: AgentSessionOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID().replaceAll("-", "");
    this.eventBus = options.eventBus ?? new EventBus();
    this.taskRegistry = options.taskRegistry ?? new TaskRegistry();
    this.pending = new PendingQueue();
    this.held = new HeldQueue();
    this.deadLetters = new DeadLetterQueue();
    this.scheduler = new Scheduler({
      pending: this.pending,
      held: this.held,
      deadLetters: this.deadLetters,
    });
    this.router = new EventRouter(this.taskRegistry, {
      semanticClassifier: options.semanticClassifier ?? null,
      safetyPolicy: options.safetyPolicy ?? null,
    });
    this.runner = runner;
    this.#commandDispatcher = options.commandDispatcher ?? null;
    this.eventBus.publish(EventKind.SessionReady, {
      source: EventSource.Session,
      session_id: this.sessionId,
      payload: {},
    });
  }

  get state(): SessionState {
    return this.#state;
  }

  get activeTask(): TaskRecord | null {
    return this.taskRegistry.active();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get heldCount(): number {
    return this.held.size;
  }

  /**
   * Compatibility API for existing callers while they migrate to submitAction.
   */
  async submitInput(
    content: string,
    options: { strategy?: string } = {},
  ): Promise<Submission> {
    if (this.#state === SessionState.Stopped) {
      throw new Error("session is stopped");
    }
    const text = content.trim();
    if (!text) {
      throw new Error("input must not be empty");
    }
    const strategy = options.strategy;
    if (strategy !== undefined && !ROUTE_STRATEGIES.has(strategy)) {
      throw new Error(`unknown route strategy: ${strategy}`);
    }
    if (text === "/cancel") {
      const event = this.publishInput(EventKind.InputSlashCommand, text);
      const routed = await this.router.route(event);
      this.cancelRouted(routed);
      return {
        event,
        routed,
        taskId: routed.decision.taskId,
        queued: false,
        control: true,
        rejected: false,
        reason: "",
      };
    }

    const kind = text.startsWith("/")
      ? EventKind.InputSlashCommand
      : EventKind.InputUserMessage;
    const event = this.publishInput(kind, text, strategy);
    const routingTaskId = this.taskRegistry.activeTaskId;
    // Layer-three classification may make a network request. The event loop
    // stays free while awaiting it, so the worker can finish, cancel, or
    // reach a safe point; the decision is repaired afterwards if it did.
    const routed = this.refreshRouteForCurrentTask(
      await this.router.route(event),
      routingTaskId,
    );
    // From here on the section is synchronous and therefore atomic.
    this.publishRoute(routed);
    const scheduled = this.scheduler.schedule(routed);
    let taskId = routed.decision.taskId;
    if (routed.decision.destination === "new_task") {
      taskId = this.startTask(text, event.event_id);
    } else if (routed.decision.destination === "pending") {
      this.eventBus.publish(EventKind.InputPending, {
        source: EventSource.Session,
        session_id: this.sessionId,
        task_id: taskId,
        correlation_id: event.event_id,
        payload: { pending_count: this.pending.size },
      });
    } else if (routed.decision.destination === "held") {
      this.eventBus.publish(EventKind.InputHeld, {
        source: EventSource.Session,
        session_id: this.sessionId,
        task_id: taskId,
        correlation_id: event.event_id,
        payload: { held_count: this.held.size },
      });
    }
    if (scheduled.rejected) {
      this.eventBus.publish(EventKind.RoutingRejected, {
        source: EventSource.Router,
        session_id: this.sessionId,
        task_id: taskId,
        correlation_id: event.event_id,
        payload: {
          reason: scheduled.reason,
          destination: "drop",
          layer: 4,
        },
      });
    }
    return {
      event,
      routed,
      taskId,
      queued: scheduled.queued,
      control: routed.decision.destination === "control",
      rejected: scheduled.rejected,
      reason: scheduled.reason,
    };
  }

  /** Compatibility bridge from neutral actions to the existing session API. */
  async submitAction(action: SessionAction): Promise<Submission | boolean> {
    switch (action.type) {
      case "prompt":
        return this.submitInput(action.text);
      case "steer":
        return this.submitInput(action.text, { strategy: "steer" });
      case "follow_up":
        return this.submitInput(action.text, { strategy: "follow_up" });
      case "approval":
        return this.submitInput(action.text, { strategy: "steer" });
      case "answer":
        return this.submitInput(action.text, { strategy: "follow_up" });
      case "cancel":
        return this.requestCancel(action.reason);
      case "command": {
        if (this.#commandDispatcher === null) {
          return false;
        }
        const command =
          action.text ?? [action.name, ...action.arguments].join(" ");
        return this.#commandDispatcher(command);
      }
      case "exit":
        return this.close();
    }
  }

  /** Repair a decision if task state changed during semantic routing. */
  private refreshRouteForCurrentTask(
    routed: RoutedEvent,
    routingTaskId: string | null,
  ): RoutedEvent {
    const decision = routed.decision;
    const active = this.taskRegistry.active();
    const destination = decision.destination;
    if (routingTaskId !== null) {
      const original = this.taskRegistry.get(routingTaskId);
      if (active !== null && active.taskId === routingTaskId) {
        if (active.state !== TaskState.Cancelling) {
          return routed;
        }
      } else if (
        active === null &&
        original !== null &&
        original.state === TaskState.Completed
      ) {
        return {
          event: routed.event,
          decision: {
            taskId: null,
            destination: "new_task",
            timing: "immediate",
            strategy: "execute",
            confidence: 1.0,
            reason: "original task completed while routing; start follow-up task",
            layer: 4,
          },
        };
      }
      return {
        event: routed.event,
        decision: {
          taskId: routingTaskId,
          destination: "held",
          timing: "after_cancel",
          strategy: "follow_up",
          confidence: 1.0,
          reason: "original task stopped or changed while routing; hold input",
          layer: 4,
        },
      };
    }

    const stale =
      (destination === "new_task" && active !== null) ||
      ((destination === "pending" || destination === "held") &&
        (active === null || decision.taskId !== active.taskId));
    if (!stale) {
      return routed;
    }
    let replacement: RouteDecision;
    if (active === null) {
      replacement = {
        taskId: null,
        destination: "new_task",
        timing: "immediate",
        strategy: "execute",
        confidence: 1.0,
        reason: "task state changed while routing; start a new task",
        layer: 4,
      };
    } else if (active.state === TaskState.Cancelling) {
      replacement = {
        taskId: active.taskId,
        destination: "held",
        timing: "after_cancel",
        strategy: "follow_up",
        confidence: 1.0,
        reason: "task began cancelling while routing; hold input",
        layer: 4,
      };
    } else {
      replacement = {
        taskId: active.taskId,
        destination: "pending",
        timing: "safe_point",
        strategy: "follow_up",
        confidence: 1.0,
        reason: "active task changed while routing; queue safe follow-up",
        layer: 4,
      };
    }
    return { event: routed.event, decision: replacement };
  }

  requestCancel(reason: string = "cancelled by user"): boolean {
    const event = this.eventBus.publish(EventKind.InputCancelRequested, {
      source: EventSource.User,
      session_id: this.sessionId,
      payload: { reason },
    });
    // EventRouter.route is async, but for InputCancelRequested the outcome is
    // pinned by the layer-four safety arbiter regardless of classifier or
    // policy verdicts, so the decision can be produced synchronously. (The
    // policy callback itself is not invoked on this fast path.)
    const active = this.taskRegistry.active();
    const routed: RoutedEvent = {
      event,
      decision: {
        taskId: active?.taskId ?? null,
        destination: "control",
        timing: "immediate",
        strategy: "cancel",
        confidence: 1.0,
        reason: "safety arbiter preserves immediate cancellation",
        layer: 4,
      },
    };
    return this.cancelRouted(routed, reason);
  }

  /** Command-facing alias for task-scoped cancellation. */
  cancelActiveTask(): boolean {
    return this.requestCancel("cancelled by user");
  }

  queueStatus(): QueueStatus {
    return {
      pending: this.pending.size,
      held: this.held.size,
      deadLetters: this.deadLetters.size,
      pendingTokens: this.pending.estimatedTokens,
      heldTokens: this.held.estimatedTokens,
    };
  }

  /** Publish user-facing local feedback in canonical event order. */
  publishNotice(text: string, options: { style?: string } = {}): EventEnvelope<typeof EventKind.UiMessage> {
    return this.eventBus.publish(EventKind.UiMessage, {
      source: EventSource.Session,
      session_id: this.sessionId,
      payload: { text: text, style: options.style ?? "" },
    });
  }

  clearQueues(): number {
    return (
      this.pending.clear() + this.held.clear() + this.deadLetters.clear()
    );
  }

  /** Normalize and route a model/tool callback before fan-out. */
  async publishInternalEvent(
    kind: string,
    options: {
      source: EventSource | string;
      taskId: string;
      correlationId: string | null;
      payload?: Record<string, unknown> | undefined;
    },
  ): Promise<AnyEventEnvelope> {
    const event = this.eventBus.factory.create(kind, {
      source: options.source,
      session_id: this.sessionId,
      task_id: options.taskId,
      correlation_id: options.correlationId,
      payload: options.payload,
    }) as AnyEventEnvelope;
    const routed = await this.router.route(event);
    this.publishRoute(routed);
    if (routed.decision.destination === "drop") {
      this.deadLetters.put(event, routed.decision.reason);
      return event;
    }
    return this.eventBus.publishEvent(event) as AnyEventEnvelope;
  }

  private cancelRouted(
    routed: RoutedEvent,
    reason: string = "cancelled by user",
  ): boolean {
    this.publishRoute(routed);
    const taskId = routed.decision.taskId;
    if (taskId === null) {
      return false;
    }
    const record = this.taskRegistry.get(taskId);
    if (record === null || TERMINAL_TASK_STATES.has(record.state)) {
      return false;
    }
    this.taskRegistry.transition(taskId, TaskState.Cancelling);
    this.setSessionState(SessionState.Cancelling);
    this.holdTaskInputs(taskId, "held because its task is cancelling");
    this.publishTaskState(taskId, TaskState.Cancelling);
    return record.cancelToken.cancel(reason);
  }

  waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (this.#idle) {
      return Promise.resolve(true);
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onIdle = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.#idleWaiters.delete(onIdle);
        resolve(true);
      };
      this.#idleWaiters.add(onIdle);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#idleWaiters.delete(onIdle);
          resolve(false);
        }, timeoutMs);
        // A pending wait must never hold the process open on its own.
        timer.unref();
      }
    });
  }

  isTaskActive(taskId: string): boolean {
    const active = this.taskRegistry.active();
    return active !== null && active.taskId === taskId;
  }

  /** Start all held user inputs as one new task when currently idle. */
  resumeHeld(): number {
    if (this.taskRegistry.active() !== null) {
      return 0;
    }
    const held = this.held.drain();
    const content = combineInput(held);
    if (!content) {
      return 0;
    }
    this.startTask(content, null);
    return held.length;
  }

  clearHeld(): number {
    return this.held.drain().length;
  }

  async close(options: CloseOptions = {}): Promise<boolean> {
    const wait = options.wait ?? true;
    if (this.#state === SessionState.Stopped) {
      // A previous close may still be draining subscriber mailboxes; a
      // returned close() must imply subscribers saw the terminal event.
      await this.#finalizePromise;
      return true;
    }
    this.#closeRequested = true;
    if (this.activeTask !== null) {
      this.requestCancel("session closed");
    }
    let clean = true;
    if (wait) {
      // Idle is only published by the owning worker after it settles, so a
      // true result implies the worker has fully returned.
      clean = await this.waitForIdle(options.timeoutMs);
    } else if (this.#workerActive) {
      clean = false;
    }
    if (!clean) {
      return false;
    }
    await this.finalizeStop();
    return true;
  }

  private finalizeStop(): Promise<void> {
    if (this.#state === SessionState.Stopped) {
      // settleWorker may already have started finalization; join it so
      // callers still observe the bus fully closed.
      return this.#finalizePromise ?? Promise.resolve();
    }
    this.#state = SessionState.Stopped;
    this.eventBus.publish(EventKind.SessionStopped, {
      source: EventSource.Session,
      session_id: this.sessionId,
      payload: {},
    });
    // Python's close() runs bus.close() synchronously before returning, so
    // subscribers are guaranteed to have seen the terminal event once the
    // returned promise resolves.
    this.#finalizePromise = this.eventBus.close();
    return this.#finalizePromise;
  }

  private publishInput(
    kind: typeof EventKind.InputSlashCommand | typeof EventKind.InputUserMessage,
    content: string,
    strategy?: string,
  ): AnyEventEnvelope {
    const payload: { content: string; strategy?: string } = { content };
    if (strategy !== undefined) {
      payload.strategy = strategy;
    }
    const options = {
      source: EventSource.User,
      session_id: this.sessionId,
      payload,
    };
    return kind === EventKind.InputSlashCommand
      ? this.eventBus.publish(EventKind.InputSlashCommand, options)
      : this.eventBus.publish(EventKind.InputUserMessage, options);
  }

  private publishRoute(routed: RoutedEvent): void {
    const decision = routed.decision;
    const kind =
      decision.destination === "drop"
        ? EventKind.RoutingRejected
        : EventKind.RoutingDecided;
    this.eventBus.publish(kind, {
      source: EventSource.Router,
      session_id: this.sessionId,
      task_id: decision.taskId,
      correlation_id: routed.event.event_id,
      payload: {
        destination: decision.destination,
        timing: decision.timing,
        strategy: decision.strategy,
        confidence: decision.confidence,
        reason: decision.reason,
        layer: decision.layer,
      },
    });
  }

  private startTask(content: string, inputEventId: string | null): string {
    const taskId = randomUUID().replaceAll("-", "");
    this.taskRegistry.register(taskId);
    this.setIdle(false);
    this.setSessionState(SessionState.Running);
    this.eventBus.publish(EventKind.TaskStarted, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      correlation_id: inputEventId,
      payload: {
        pending_count: this.pending.size,
        held_count: this.held.size,
      },
    });
    const workerKey = {};
    this.#worker = workerKey;
    this.#workerActive = true;
    const worker = this.runTask(workerKey, taskId, content);
    // The task body handles runner failures itself; this guard only prevents
    // an unhandled rejection if event publication itself fails during
    // teardown (the Python original lost those to the daemon thread as well).
    void worker.catch(() => {});
    return taskId;
  }

  private async runTask(
    workerKey: object,
    taskId: string,
    content: string,
  ): Promise<void> {
    const context = new TaskContext(this, taskId);
    let currentInput = content;
    let currentBatch: PendingInputBatch | null = null;
    let result: string | null = null;
    try {
      for (;;) {
        context.cancelToken.throwIfCancelled();
        this.setRunningState(taskId, TaskState.RunningModel);
        context.setClaimedInput(currentBatch);
        result = await this.invokeRunner(currentInput, context);
        if (currentBatch !== null) {
          this.ackClaimedInput(taskId, currentBatch.eventIds);
        }
        context.cancelToken.throwIfCancelled();
        let cancelledAtBoundary = false;
        // Synchronous critical section: drain or complete atomically.
        const batch = this.drainPending(taskId);
        if (batch.events.length > 0) {
          currentInput = batch.content;
          currentBatch = batch;
          continue;
        }
        const record = this.taskRegistry.get(taskId);
        cancelledAtBoundary =
          record === null ||
          record.state === TaskState.Cancelling ||
          record.cancelToken.isCancelled();
        if (!cancelledAtBoundary) {
          this.taskRegistry.transition(
            taskId,
            TaskState.Completed,
            result === null ? {} : { result },
          );
          this.eventBus.publish(EventKind.TaskCompleted, {
            source: EventSource.Session,
            session_id: this.sessionId,
            task_id: taskId,
            payload: {
              result: result ?? "",
              pending_count: this.pending.size,
              held_count: this.held.size,
            },
          });
        }
        if (cancelledAtBoundary) {
          this.finishCancelled(taskId);
        }
        break;
      }
    } catch (error) {
      if (error instanceof CancellationError) {
        this.finishCancelled(taskId);
      } else {
        const record = this.taskRegistry.get(taskId);
        if (record !== null && record.cancelToken.isCancelled()) {
          this.finishCancelled(taskId);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.holdTaskInputs(taskId, "held because its task failed");
          this.taskRegistry.transition(taskId, TaskState.Failed, {
            error: message,
          });
          this.eventBus.publish(EventKind.TaskFailed, {
            source: EventSource.Session,
            session_id: this.sessionId,
            task_id: taskId,
            payload: {
              error: message,
              pending_count: this.pending.size,
              held_count: this.held.size,
            },
          });
        }
      }
    } finally {
      this.settleWorker(workerKey);
    }
  }

  private settleWorker(workerKey: object): void {
    let shouldFinalize = false;
    // A follow-up task may start after this task transitions to a terminal
    // TaskState but before its worker returns. Only the worker which still
    // owns the Session may publish the shared idle state; an older worker
    // must not clobber its successor.
    const ownsSession = this.#worker === workerKey;
    if (ownsSession) {
      this.#workerActive = false;
    }
    const noActiveTask = this.taskRegistry.active() === null;
    if (ownsSession && noActiveTask) {
      if (this.#state !== SessionState.Stopped) {
        this.setSessionState(SessionState.Idle);
      }
      this.setIdle(true);
      shouldFinalize = this.#closeRequested;
    }
    if (shouldFinalize) {
      // No one awaits this path (close() already returned false or was never
      // called); mirror the worker guard so a bus teardown failure cannot
      // surface as an unhandled rejection.
      void this.finalizeStop().catch(() => {});
    }
  }

  /** @internal Test hook mirroring Python's ``_settle_worker``. */
  _settleWorker(workerKey: object): void {
    this.settleWorker(workerKey);
  }

  private finishCancelled(taskId: string): void {
    const record = this.taskRegistry.get(taskId);
    if (record === null || TERMINAL_TASK_STATES.has(record.state)) {
      return;
    }
    this.holdTaskInputs(taskId, "held because its task was cancelled");
    this.taskRegistry.transition(taskId, TaskState.Cancelled);
    this.eventBus.publish(EventKind.TaskCancelled, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      payload: {
        reason: record.cancelToken.reason ?? "cancelled",
        pending_count: this.pending.size,
        held_count: this.held.size,
      },
    });
  }

  /** Rollback and preserve every unacknowledged input for a task. */
  private holdTaskInputs(taskId: string, reason: string): number {
    const rollback = this.#inflightRollbacks.get(taskId);
    this.#inflightRollbacks.delete(taskId);
    if (rollback !== undefined) {
      try {
        rollback();
      } catch {
        // A faulty rollback must not lose the inputs being preserved.
      }
    }
    const inflight = this.#inflightPending.get(taskId) ?? [];
    this.#inflightPending.delete(taskId);
    const items = [...this.pending.drainTask(taskId), ...inflight];
    let heldCount = 0;
    for (const pending of items) {
      const held: RoutedEvent = {
        event: pending.event,
        decision: {
          ...pending.decision,
          destination: "held",
          timing: "after_cancel",
          strategy: "follow_up",
          reason,
          layer: 4,
        },
      };
      try {
        this.held.put(held);
        heldCount += 1;
      } catch (error) {
        if (!(error instanceof QueueOverflowError)) {
          throw error;
        }
        this.deadLetters.put(pending.event, "held queue is full");
        this.eventBus.publish(EventKind.RoutingRejected, {
          source: EventSource.Router,
          session_id: this.sessionId,
          task_id: taskId,
          correlation_id: pending.event.event_id,
          payload: { reason: "held queue is full" },
        });
      }
    }
    return heldCount;
  }

  private async invokeRunner(
    content: string,
    context: TaskContext,
  ): Promise<string | null> {
    const runner = this.runner;
    const fn =
      typeof runner === "function" ? runner : runner.run.bind(runner);
    return (await fn(content, context)) ?? null;
  }

  /** @internal Used by {@link TaskContext}. */
  setRunningState(taskId: string, state: TaskState): boolean {
    if (state !== TaskState.RunningModel && state !== TaskState.RunningTools) {
      throw new Error("TaskContext can only enter model or tool running state");
    }
    const record = this.taskRegistry.get(taskId);
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      TERMINAL_TASK_STATES.has(record.state)
    ) {
      return false;
    }
    if (record.state !== state) {
      this.taskRegistry.transition(taskId, state);
      this.publishTaskState(taskId, state);
    }
    return true;
  }

  /** @internal Used by {@link TaskContext}. */
  commitIfActive(taskId: string, callback: () => void): boolean {
    const record = this.taskRegistry.get(taskId);
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      record.cancelToken.isCancelled()
    ) {
      return false;
    }
    callback();
    return true;
  }

  /** @internal Used by {@link TaskContext}. */
  commitClaimedInput(
    taskId: string,
    eventIds: readonly string[],
    callback: () => void,
    rollback: () => void,
  ): boolean {
    const record = this.taskRegistry.get(taskId);
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      record.cancelToken.isCancelled()
    ) {
      return false;
    }
    if (eventIds.length > 0) {
      const inflight = this.#inflightPending.get(taskId) ?? [];
      if (!sameEventIds(inflight, eventIds)) {
        return false;
      }
    }
    callback();
    if (eventIds.length > 0) {
      this.#inflightRollbacks.set(taskId, rollback);
    }
    return true;
  }

  /** @internal Used by {@link TaskContext} and the worker loop. */
  ackClaimedInput(taskId: string, eventIds: readonly string[]): boolean {
    if (eventIds.length === 0) {
      return true;
    }
    const record = this.taskRegistry.get(taskId);
    const inflight = this.#inflightPending.get(taskId) ?? [];
    if (
      record === null ||
      record.state === TaskState.Cancelling ||
      record.cancelToken.isCancelled() ||
      !sameEventIds(inflight, eventIds)
    ) {
      return false;
    }
    this.#inflightPending.delete(taskId);
    this.#inflightRollbacks.delete(taskId);
    return true;
  }

  private publishTaskState(taskId: string, state: TaskState): void {
    this.eventBus.publish(EventKind.TaskStateChanged, {
      source: EventSource.Session,
      session_id: this.sessionId,
      task_id: taskId,
      payload: {
        state,
        state_name: state.toUpperCase(),
        pending_count: this.pending.size,
        held_count: this.held.size,
      },
    });
  }

  /** @internal Used by {@link TaskContext.safePoint} and the worker loop. */
  drainPending(taskId: string): PendingInputBatch {
    const record = this.taskRegistry.get(taskId);
    if (record === null || record.state === TaskState.Cancelling) {
      return EMPTY_BATCH;
    }
    if (this.#inflightPending.has(taskId)) {
      throw new Error("pending batch is already in flight");
    }
    const events = this.scheduler.safePoint(taskId);
    if (events.length > 0) {
      this.#inflightPending.set(taskId, events);
      this.publishTaskState(taskId, record.state);
    }
    return makeBatch(events);
  }

  private setSessionState(state: SessionState): void {
    this.#state = state;
  }

  private setIdle(value: boolean): void {
    this.#idle = value;
    if (value) {
      const waiters = [...this.#idleWaiters];
      this.#idleWaiters.clear();
      for (const resolve of waiters) {
        resolve();
      }
    }
  }
}
