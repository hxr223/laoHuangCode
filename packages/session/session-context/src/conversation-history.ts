import { randomUUID } from "node:crypto";

import type {
  AssistantModelMessage,
  ModelFinishReason,
  ModelUsage,
  SystemModelMessage,
  ToolResultModelMessage,
  UserModelMessage,
} from "@laohuang/llm";
import type {
  CompactionEntry,
  CompactionPayload,
  NewSessionEntry,
  SessionEntry,
  SessionJournal,
  SessionReplay,
  ToolResultEntry,
  UserMessageEntry,
  InstructionFileRecord,
} from "@laohuang/session-store";
import { ContextUsage } from "./context-usage.ts";

export interface SystemContextInput {
  readonly message: SystemModelMessage;
  readonly cwd: string;
  readonly supersedesEntryId?: string;
}

export interface ProjectInstructionsInput {
  readonly message: UserModelMessage;
  readonly files: readonly InstructionFileRecord[];
  readonly supersedesEntryIds?: readonly string[];
}

export interface UserMessageInput {
  readonly message: UserModelMessage;
  readonly inputEventIds: readonly string[];
  readonly source: "direct" | "pending" | "fork_editor";
}

export interface AssistantMessageInput {
  readonly message: AssistantModelMessage;
  readonly requestId: string;
  readonly finishReason: ModelFinishReason;
  readonly usage?: ModelUsage;
}

export interface ToolResultsInput {
  readonly requestId: string;
  readonly messages: readonly ToolResultModelMessage[];
  readonly recovered: boolean;
}

export interface ReminderInput {
  readonly message: UserModelMessage;
  readonly reason: "repeat_tool" | "runtime";
}

export interface StagedUserMessage {
  readonly token: string;
  readonly message: UserModelMessage;
  readonly inputEventIds: readonly string[];
}

export class ConversationHistory {
  readonly #journal: SessionJournal;
  readonly #entries: SessionEntry[];
  readonly #staged = new Map<string, UserMessageInput>();
  readonly #contextUsage: ContextUsage;
  readonly #listeners = new Set<() => void>();

  private constructor(entries: readonly SessionEntry[], journal: SessionJournal) {
    this.#entries = [...entries];
    this.#journal = journal;
    this.#contextUsage = new ContextUsage(entries);
  }

  static fromReplay(
    replay: SessionReplay,
    journal: SessionJournal,
  ): ConversationHistory {
    const history = new ConversationHistory(
      replay.items.filter((item): item is SessionEntry => item.kind === "entry"),
      journal,
    );
    for (const open of replay.openToolCalls) {
      const entry = history.appendToolResults({
        requestId: "recovered",
        recovered: true,
        messages: [{
          role: "tool-result",
          toolCallId: open.toolCallId,
          toolName: open.toolName,
          content: JSON.stringify({
            ok: false,
            status: "interrupted",
            error: "Tool execution was interrupted before a result was recorded.",
          }),
          isError: true,
        }],
      })[0];
      journal.appendRecord({
        recordType: "error",
        payload: {
          type: "interrupted_tool_call",
          toolCallId: open.toolCallId,
          repairedEntryId: entry?.id ?? null,
        },
      });
    }
    return history;
  }

  appendSystemContext(input: SystemContextInput): SessionEntry {
    return this.append({
      entryType: "system_context",
      payload: input,
    });
  }

  appendProjectInstructions(input: ProjectInstructionsInput): SessionEntry | null {
    if (input.message.content === "") {
      return null;
    }
    return this.append({
      entryType: "project_instructions",
      payload: {
        message: input.message,
        files: input.files,
        supersedesEntryIds: input.supersedesEntryIds ?? [],
      },
    });
  }

  appendUser(input: UserMessageInput): UserMessageEntry {
    return this.append({
      entryType: "user_message",
      payload: input,
    }) as UserMessageEntry;
  }

  stageUser(input: UserMessageInput): StagedUserMessage {
    const token = randomUUID().replaceAll("-", "");
    this.#staged.set(token, input);
    return {
      token,
      message: input.message,
      inputEventIds: input.inputEventIds,
    };
  }

  commitStagedUser(token: string): UserMessageEntry {
    const staged = this.#staged.get(token);
    if (staged === undefined) {
      throw new Error(`unknown staged user message: ${token}`);
    }
    this.#staged.delete(token);
    return this.appendUser(staged);
  }

  discardStagedUser(token: string): void {
    this.#staged.delete(token);
  }

  appendAssistant(input: AssistantMessageInput): SessionEntry {
    return this.append({
      entryType: "assistant_message",
      payload: input,
    });
  }

  appendToolResults(input: ToolResultsInput): readonly ToolResultEntry[] {
    return input.messages.map((message) =>
      this.append({
        entryType: "tool_result",
        payload: {
          message,
          requestId: input.requestId,
          recovered: input.recovered,
        },
      }) as ToolResultEntry,
    );
  }

  appendReminder(input: ReminderInput): SessionEntry {
    return this.append({
      entryType: "reminder",
      payload: input,
    });
  }

  appendToolDefinitions(input: { readonly message: SystemModelMessage }): SessionEntry {
    return this.append({ entryType: "tool_definitions", payload: input });
  }

  appendToolCatalog(input: { readonly message: UserModelMessage }): SessionEntry {
    return this.append({ entryType: "tool_catalog", payload: input });
  }

  appendCompaction(input: CompactionPayload): CompactionEntry {
    return this.append({
      entryType: "compaction",
      payload: input,
    }) as CompactionEntry;
  }

  entries(): readonly SessionEntry[] {
    return [...this.#entries];
  }

  get contextTokens(): number | null {
    return this.#contextUsage.tokens;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  private append(input: NewSessionEntry): SessionEntry {
    const entry = this.#journal.appendEntry(input);
    this.#entries.push(entry);
    this.#contextUsage.append(entry);
    for (const listener of this.#listeners) listener();
    return entry;
  }
}
