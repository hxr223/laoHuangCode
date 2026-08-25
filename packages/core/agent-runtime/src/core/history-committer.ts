import type { CancelToken } from "@laohuang/runtime-protocol";
import type { AssembledToolCall } from "@laohuang/llm";
import type { ToolResult } from "@laohuang/tools";
import type { PendingInputBatchLike } from "@laohuang/runtime-protocol";

export type HistoryMessage = Record<string, unknown>;

export interface HistoryCommitContext {
  commitInput?(append: () => void, rollback: () => void): boolean;
  commitPending?(
    batch: PendingInputBatchLike,
    append: () => void,
    rollback: () => void,
  ): boolean;
  commitIfActive?(callback: () => void): boolean;
}

export interface HistoryCommitterOptions {
  messages: HistoryMessage[];
  context: HistoryCommitContext | null;
  cancelToken: CancelToken | null;
  createCancelled(message: string): Error;
}

/** Commits canonical conversation history while preserving session atomicity. */
export class HistoryCommitter {
  private readonly messages: HistoryMessage[];
  private readonly context: HistoryCommitContext | null;
  private readonly cancelToken: CancelToken | null;
  private readonly createCancelled: (message: string) => Error;

  constructor(options: HistoryCommitterOptions) {
    this.messages = options.messages;
    this.context = options.context;
    this.cancelToken = options.cancelToken;
    this.createCancelled = options.createCancelled;
  }

  commitInput(content: string): boolean {
    const message: HistoryMessage = { role: "user", content };
    const commitInput = this.context?.commitInput;
    if (typeof commitInput === "function") {
      return this.commitContextMessage(
        (append, rollback) => commitInput.call(this.context, append, rollback),
        message,
      );
    }
    this.raiseIfCancelled();
    this.messages.push(message);
    return true;
  }

  commitPending(batch: PendingInputBatchLike): boolean {
    const content = batch.content ?? "";
    if (content === "") {
      return true;
    }
    const message: HistoryMessage = { role: "user", content };
    const commitPending = this.context?.commitPending;
    if (typeof commitPending === "function") {
      return this.commitContextMessage(
        (append, rollback) => commitPending.call(this.context, batch, append, rollback),
        message,
      );
    }
    this.raiseIfCancelled();
    this.messages.push(message);
    return true;
  }

  commitAssistant(message: HistoryMessage): boolean {
    const commitIfActive = this.context?.commitIfActive;
    if (typeof commitIfActive === "function") {
      return commitIfActive.call(this.context, () => {
        this.messages.push(message);
      });
    }
    this.raiseIfCancelled();
    this.messages.push(message);
    return true;
  }

  commitToolResults(
    toolCalls: readonly AssembledToolCall[],
    toolResults: readonly ToolResult[],
  ): void {
    for (let index = 0; index < toolCalls.length; index += 1) {
      this.messages.push({
        role: "tool",
        tool_call_id: toolCalls[index]?.id,
        content: JSON.stringify(toolResults[index]),
      });
    }
  }

  snapshot(): HistoryMessage[] {
    return [...this.messages];
  }

  private commitContextMessage(
    commit: (append: () => void, rollback: () => void) => boolean,
    message: HistoryMessage,
  ): boolean {
    const append = (): void => {
      this.messages.push(message);
    };
    const rollback = (): void => {
      if (this.messages.at(-1) === message) {
        this.messages.pop();
      }
    };
    return Boolean(commit(append, rollback));
  }

  private raiseIfCancelled(): void {
    if (this.cancelToken !== null && this.cancelToken.isCancelled()) {
      throw this.createCancelled(this.cancelToken.reason || "cancelled");
    }
  }
}
