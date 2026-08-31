import {
  portableModelMessage,
  type ModelMessage,
} from "@laohuang/llm";
import type {
  AssistantMessageEntry,
  CompactionEntry,
  ContextResetEntry,
  ProjectInstructionsEntry,
  SessionEntry,
  SystemContextEntry,
} from "@laohuang/session-store";

export interface BuildContextInput {
  readonly entries: readonly SessionEntry[];
  readonly currentProvider: string;
  readonly currentModel: string;
}

export interface BuiltContext {
  readonly messages: readonly ModelMessage[];
  readonly sourceEntryIds: readonly string[];
  readonly activeCompactionId: string | null;
  readonly resetEntryId: string | null;
}

export class ContextBuildError extends Error {
  readonly entryId: string;

  constructor(entryId: string, message: string) {
    super(`${entryId}: ${message}`);
    this.name = "ContextBuildError";
    this.entryId = entryId;
  }
}

export class ContextBuilder {
  build(input: BuildContextInput): BuiltContext {
    const sorted = [...input.entries].sort((left, right) => left.seq - right.seq);
    const superseded = supersededEntryIds(sorted);
    const reset = latestEntry(sorted, "context_reset");
    const resetThroughSeq = reset?.payload.resetThroughSeq ?? 0;
    const activeCompaction = latestCompaction(sorted, resetThroughSeq);
    const selected: SelectedMessage[] = [];
    const system = latestActive(sorted, "system_context", superseded);
    if (system !== null) {
      selected.push({ entryId: system.id, message: system.payload.message });
    }
    for (const entry of sorted) {
      if (entry.entryType === "project_instructions" && !superseded.has(entry.id)) {
        selected.push({ entryId: entry.id, message: entry.payload.message });
      }
    }
    if (activeCompaction !== null) {
      selected.push({
        entryId: activeCompaction.id,
        message: {
          role: "user",
          content: `<conversation_summary>\n${activeCompaction.payload.summary}\n</conversation_summary>`,
        },
      });
    }
    for (const entry of conversationTail(sorted, resetThroughSeq, activeCompaction)) {
      const message = modelMessageForEntry(entry, input.currentProvider, input.currentModel);
      if (message !== null) {
        selected.push({ entryId: entry.id, message });
      }
    }
    validateToolPairs(selected);
    return {
      messages: selected.map((item) => item.message),
      sourceEntryIds: selected.map((item) => item.entryId),
      activeCompactionId: activeCompaction?.id ?? null,
      resetEntryId: reset?.id ?? null,
    };
  }
}

interface SelectedMessage {
  readonly entryId: string;
  readonly message: ModelMessage;
}

function supersededEntryIds(entries: readonly SessionEntry[]): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const entry of entries) {
    if (entry.entryType === "system_context" && entry.payload.supersedesEntryId !== undefined) {
      superseded.add(entry.payload.supersedesEntryId);
    }
    if (entry.entryType === "project_instructions") {
      for (const id of entry.payload.supersedesEntryIds) {
        superseded.add(id);
      }
    }
  }
  return superseded;
}

function latestEntry<T extends SessionEntry["entryType"]>(
  entries: readonly SessionEntry[],
  entryType: T,
): Extract<SessionEntry, { readonly entryType: T }> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.entryType === entryType) {
      return entry as Extract<SessionEntry, { readonly entryType: T }>;
    }
  }
  return null;
}

function latestActive<T extends "system_context" | "project_instructions">(
  entries: readonly SessionEntry[],
  entryType: T,
  superseded: ReadonlySet<string>,
): Extract<SessionEntry, { readonly entryType: T }> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.entryType === entryType && !superseded.has(entry.id)) {
      return entry as Extract<SessionEntry, { readonly entryType: T }>;
    }
  }
  return null;
}

function latestCompaction(
  entries: readonly SessionEntry[],
  resetThroughSeq: number,
): CompactionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.entryType === "compaction" && entry.seq > resetThroughSeq) {
      return entry;
    }
  }
  return null;
}

function conversationTail(
  entries: readonly SessionEntry[],
  resetThroughSeq: number,
  activeCompaction: CompactionEntry | null,
): readonly SessionEntry[] {
  const boundary = activeCompaction?.payload.retainedFromSeq ?? (resetThroughSeq + 1);
  return entries.filter((entry) =>
    entry.seq >= boundary &&
    entry.seq > resetThroughSeq &&
    entry.entryType !== "system_context" &&
    entry.entryType !== "project_instructions" &&
    entry.entryType !== "context_reset" &&
    entry.entryType !== "compaction"
  );
}

function modelMessageForEntry(
  entry: SessionEntry,
  currentProvider: string,
  currentModel: string,
): ModelMessage | null {
  if (entry.entryType === "user_message" || entry.entryType === "reminder") {
    return entry.payload.message;
  }
  if (entry.entryType === "assistant_message") {
    const message = entry.payload.message;
    if (message.provider !== currentProvider || message.model !== currentModel) {
      return portableModelMessage(message);
    }
    return message;
  }
  if (entry.entryType === "tool_result") {
    return entry.payload.message;
  }
  return null;
}

function validateToolPairs(selected: readonly SelectedMessage[]): void {
  let expected: readonly string[] = [];
  let ownerEntryId: string | null = null;
  for (const item of selected) {
    if (item.message.role === "assistant") {
      if (expected.length > 0) {
        throw new ContextBuildError(ownerEntryId ?? item.entryId, "missing tool result");
      }
      expected = item.message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => block.call.id);
      ownerEntryId = expected.length === 0 ? null : item.entryId;
      continue;
    }
    if (item.message.role === "tool-result") {
      const [next, ...rest] = expected;
      if (next === undefined) {
        throw new ContextBuildError(item.entryId, "orphan tool result");
      }
      if (item.message.toolCallId !== next) {
        throw new ContextBuildError(item.entryId, "tool result order does not match tool call order");
      }
      expected = rest;
      ownerEntryId = expected.length === 0 ? null : ownerEntryId;
      continue;
    }
    if (expected.length > 0) {
      throw new ContextBuildError(ownerEntryId ?? item.entryId, "missing tool result");
    }
  }
  if (expected.length > 0) {
    throw new ContextBuildError(ownerEntryId ?? "unknown", "missing tool result");
  }
}
