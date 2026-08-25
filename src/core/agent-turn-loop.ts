import { CancellationError, type CancelToken } from "../cancellation.ts";
import { TaskLifecycle, TaskState } from "./task-lifecycle.ts";
import type { QueueBridge, QueueInputBatch } from "./queue-bridge.ts";

export interface AgentTurnContext {
  readonly cancelToken: CancelToken;
  setClaimedInput(batch: QueueInputBatch | null): void;
}

export type AgentTurnRunnerResult = string | null | Promise<string | null>;

export interface AgentTurnRunnerLike<Context extends AgentTurnContext> {
  run(userInput: string, context: Context): AgentTurnRunnerResult;
}

export type AgentTurnRunner<Context extends AgentTurnContext> =
  | ((content: string, context: Context) => AgentTurnRunnerResult)
  | AgentTurnRunnerLike<Context>;

export type TurnLoopResult =
  | { readonly status: "completed"; readonly result: string | null }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly error: string };

export interface AgentTurnLoopOptions<Context extends AgentTurnContext> {
  readonly lifecycle: TaskLifecycle;
  readonly bridge: QueueBridge;
  readonly runner: AgentTurnRunner<Context>;
}

/** Runs consecutive model turns until the task reaches a terminal state. */
export class AgentTurnLoop<Context extends AgentTurnContext> {
  private readonly lifecycle: TaskLifecycle;
  private readonly bridge: QueueBridge;
  private readonly runner: AgentTurnRunner<Context>;

  constructor(options: AgentTurnLoopOptions<Context>) {
    this.lifecycle = options.lifecycle;
    this.bridge = options.bridge;
    this.runner = options.runner;
  }

  async run(
    taskId: string,
    content: string,
    context: Context,
  ): Promise<TurnLoopResult> {
    let currentInput = content;
    let currentBatch: QueueInputBatch | null = null;
    try {
      for (;;) {
        context.cancelToken.throwIfCancelled();
        this.lifecycle.markModelRunning(taskId);
        context.setClaimedInput(currentBatch);
        const result = await this.invokeRunner(currentInput, context);
        if (currentBatch !== null) {
          this.bridge.acknowledgeClaimedInput(taskId, currentBatch.eventIds);
        }
        context.cancelToken.throwIfCancelled();

        // Drain or complete synchronously so a boundary cancellation wins.
        const batch = this.bridge.drainPending(taskId);
        if (batch !== null) {
          currentInput = batch.content;
          currentBatch = batch;
          continue;
        }
        const record = this.lifecycle.taskRegistry.get(taskId);
        if (
          record === null ||
          record.state === TaskState.Cancelling ||
          record.cancelToken.isCancelled()
        ) {
          return this.finishCancelled(taskId);
        }
        this.lifecycle.completeTask(taskId, result);
        return { status: "completed", result };
      }
    } catch (error) {
      if (error instanceof CancellationError) {
        return this.finishCancelled(taskId);
      }
      const record = this.lifecycle.taskRegistry.get(taskId);
      if (record !== null && record.cancelToken.isCancelled()) {
        return this.finishCancelled(taskId);
      }
      const message = error instanceof Error ? error.message : String(error);
      this.bridge.preserveTaskInputs(taskId, "held because its task failed");
      this.lifecycle.failTask(taskId, message);
      return { status: "failed", error: message };
    }
  }

  private invokeRunner(content: string, context: Context): Promise<string | null> {
    const runner = this.runner;
    const fn = typeof runner === "function" ? runner : runner.run.bind(runner);
    return Promise.resolve(fn(content, context)).then((result) => result ?? null);
  }

  private finishCancelled(taskId: string): TurnLoopResult {
    const record = this.lifecycle.taskRegistry.get(taskId);
    if (record !== null && record.state === TaskState.Cancelling) {
      this.bridge.preserveTaskInputs(
        taskId,
        "held because its task was cancelled",
      );
      this.lifecycle.finishCancelled(taskId);
    }
    return { status: "cancelled" };
  }
}
