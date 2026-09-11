import type { CancelToken } from "@laohuang/runtime-protocol";
import type { ModelMessage, ModelUsage } from "@laohuang/llm";
import type { ToolCall, ToolResult } from "@laohuang/tools";
import type { PendingInputBatchLike } from "@laohuang/runtime-protocol";

export type HistoryMessage = ModelMessage;

export interface ConversationHistoryLike {
  appendToolDefinitions?(input: { readonly message: Extract<ModelMessage, { role: "system" }> }): unknown;
  appendToolCatalog?(input: { readonly message: Extract<ModelMessage, { role: "user" }> }): unknown;
  appendUser(input: {
    readonly message: Extract<ModelMessage, { readonly role: "user" }>;
    readonly inputEventIds: readonly string[];
    readonly source: "direct" | "pending" | "fork_editor";
  }): unknown;
  appendAssistant(input: {
    readonly message: Extract<ModelMessage, { readonly role: "assistant" }>;
    readonly requestId: string;
    readonly finishReason: "stop" | "tool-calls" | "max-tokens";
    readonly usage?: ModelUsage;
  }): unknown;
  appendToolResults(input: {
    readonly requestId: string;
    readonly messages: readonly Extract<ModelMessage, { readonly role: "tool-result" }>[];
    readonly recovered: boolean;
  }): unknown;
  appendReminder(input: {
    readonly message: Extract<ModelMessage, { readonly role: "user" }>;
    readonly reason: "repeat_tool" | "runtime";
  }): unknown;
}

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
  conversationHistory?: ConversationHistoryLike | null;
}

/** Commits canonical conversation history while preserving session atomicity. */
export class HistoryCommitter {
  private readonly messages: HistoryMessage[];
  private readonly context: HistoryCommitContext | null;
  private readonly cancelToken: CancelToken | null;
  private readonly createCancelled: (message: string) => Error;
  private readonly conversationHistory: ConversationHistoryLike | null;

  constructor(options: HistoryCommitterOptions) {
    this.messages = options.messages;
    this.context = options.context;
    this.cancelToken = options.cancelToken;
    this.createCancelled = options.createCancelled;
    this.conversationHistory = options.conversationHistory ?? null;
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
    this.conversationHistory?.appendUser({
      message,
      inputEventIds: [],
      source: "direct",
    });
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
    this.conversationHistory?.appendUser({
      message,
      inputEventIds: [...(batch.eventIds ?? [])],
      source: "pending",
    });
    this.messages.push(message);
    return true;
  }

  commitAssistant(message: HistoryMessage, metadata?: {
    readonly requestId: string;
    readonly finishReason: "stop" | "tool-calls" | "max-tokens";
    readonly usage?: ModelUsage;
  }): boolean {
    const commitIfActive = this.context?.commitIfActive;
    if (typeof commitIfActive === "function") {
      return commitIfActive.call(this.context, () => {
        if (message.role === "assistant" && metadata !== undefined) {
          this.conversationHistory?.appendAssistant({
            message,
            requestId: metadata.requestId,
            finishReason: metadata.finishReason,
            ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
          });
        }
        this.messages.push(message);
      });
    }
    this.raiseIfCancelled();
    if (message.role === "assistant" && metadata !== undefined) {
      this.conversationHistory?.appendAssistant({
        message,
        requestId: metadata.requestId,
        finishReason: metadata.finishReason,
        ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
      });
    }
    this.messages.push(message);
    return true;
  }

  commitToolResults(
    toolCalls: readonly ToolCall[],
    toolResults: readonly ToolResult[],
  ): void {
    const messages: Extract<ModelMessage, { readonly role: "tool-result" }>[] = [];
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      const result = toolResults[index];
      if (call === undefined || result === undefined) {
        continue;
      }
      const message: Extract<ModelMessage, { readonly role: "tool-result" }> = {
        role: "tool-result",
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(result),
        isError: result.ok !== true,
      };
      messages.push(message);
      this.messages.push(message);
    }
    this.conversationHistory?.appendToolResults({
      requestId: "tool-results",
      messages,
      recovered: false,
    });
  }

  commitReminder(content: string): void {
    this.raiseIfCancelled();
    const message: Extract<ModelMessage, { readonly role: "user" }> = { role: "user", content };
    this.conversationHistory?.appendReminder({ message, reason: "repeat_tool" });
    this.messages.push(message);
  }

  snapshot(): HistoryMessage[] {
    return [...this.messages];
  }

  commitToolContext(message: Extract<ModelMessage, { role: "system" | "user" }>): void {
    this.raiseIfCancelled();
    if (message.role === "system") this.conversationHistory?.appendToolDefinitions?.({ message });
    else this.conversationHistory?.appendToolCatalog?.({ message });
    this.messages.push(message);
  }

  /** Adopt the governor's retained context without rewriting the append-only journal. */
  retain(messages: readonly ModelMessage[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
  }

  private commitContextMessage(
    commit: (append: () => void, rollback: () => void) => boolean,
    message: HistoryMessage,
  ): boolean {
    const append = (): void => {
      if (message.role === "user") {
        this.conversationHistory?.appendUser({
          message,
          inputEventIds: [],
          source: "direct",
        });
      }
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
