/** Input batch claimed from the session queue for a subsequent turn. */
export interface QueueInputBatch {
  readonly content: string;
  readonly eventIds: readonly string[];
}

/** Queue operations needed by the outer agent turn loop. */
export interface QueueBridge {
  drainPending(taskId: string): QueueInputBatch | null;
  acknowledgeClaimedInput(taskId: string, eventIds: readonly string[]): boolean;
  preserveTaskInputs(taskId: string, reason: string): number;
}
