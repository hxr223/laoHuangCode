import type { ModelMessage } from "@laohuang/llm";
import type { SessionEntry } from "@laohuang/session-store";

import type { TokenEstimator } from "./token-estimator.ts";

export interface SemanticUnit {
  readonly entries: readonly SessionEntry[];
  readonly messages: readonly ModelMessage[];
}

export interface CompactionPlan {
  readonly summarizedEntries: readonly SessionEntry[];
  readonly retainedEntries: readonly SessionEntry[];
  readonly retainedFromSeq: number;
}

export interface SelectCompactionPlanInput {
  readonly entries: readonly SessionEntry[];
  readonly retainTokens: number;
  readonly estimator: TokenEstimator;
}

export function selectCompactionPlan(input: SelectCompactionPlanInput): CompactionPlan {
  const units = semanticUnits(input.entries);
  const retained: SemanticUnit[] = [];
  let tokens = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    const unitTokens = input.estimator.estimateMessages(unit.messages);
    retained.unshift(unit);
    tokens += unitTokens;
    if (tokens >= input.retainTokens) {
      break;
    }
  }
  if (retained.length === 0 && units.length > 0) {
    retained.push(units.at(-1)!);
  }
  const retainedFirst = retained[0]?.entries[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  const summarized = units.filter((unit) => unit.entries[0]!.seq < retainedFirst);
  return {
    summarizedEntries: summarized.flatMap((unit) => unit.entries),
    retainedEntries: retained.flatMap((unit) => unit.entries),
    retainedFromSeq: retained[0]?.entries[0]?.seq ?? 1,
  };
}

export function serializeConversation(entries: readonly SessionEntry[]): string {
  const lines = ["<conversation>"];
  for (const entry of entries) {
    lines.push(`<entry id="${entry.id}" seq="${entry.seq}" type="${entry.entryType}">`);
    if (entry.entryType === "assistant_message") {
      for (const block of entry.payload.message.content) {
        if (block.type === "tool-call") {
          lines.push(`[assistant tool-call ${block.call.id} ${block.call.name}] ${JSON.stringify(block.call.arguments)}`);
        } else {
          lines.push(`[assistant ${block.type}] ${block.text}`);
        }
      }
    } else if (entry.entryType === "tool_result") {
      lines.push(`[tool-result ${entry.payload.message.toolCallId} ${entry.payload.message.toolName}] ${entry.payload.message.content}`);
    } else if (
      entry.entryType === "user_message" ||
      entry.entryType === "reminder" ||
      entry.entryType === "project_instructions"
    ) {
      lines.push(`[${entry.payload.message.role}] ${entry.payload.message.content}`);
    }
    lines.push("</entry>");
  }
  lines.push("</conversation>");
  return lines.join("\n");
}

function semanticUnits(entries: readonly SessionEntry[]): readonly SemanticUnit[] {
  const units: SemanticUnit[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.entryType === "system_context" || entry.entryType === "project_instructions" || entry.entryType === "context_reset" || entry.entryType === "compaction") {
      continue;
    }
    if (entry.entryType === "assistant_message") {
      const toolCallIds = entry.payload.message.content
        .filter((block) => block.type === "tool-call")
        .map((block) => block.call.id);
      if (toolCallIds.length > 0) {
        const grouped: SessionEntry[] = [entry];
        for (const id of toolCallIds) {
          const resultIndex = entries.findIndex((candidate) =>
            candidate.entryType === "tool_result" &&
            candidate.payload.message.toolCallId === id
          );
          if (resultIndex < 0) {
            throw new Error(`cannot compact incomplete tool call: ${id}`);
          }
          grouped.push(entries[resultIndex]!);
        }
        units.push({ entries: grouped, messages: grouped.map(messageForEntry) });
        continue;
      }
    }
    if (entry.entryType === "tool_result") {
      continue;
    }
    units.push({ entries: [entry], messages: [messageForEntry(entry)] });
  }
  return units;
}

function messageForEntry(entry: SessionEntry): ModelMessage {
  if (entry.entryType === "assistant_message") {
    return entry.payload.message;
  }
  if (entry.entryType === "tool_result") {
    return entry.payload.message;
  }
  if (entry.entryType === "user_message" || entry.entryType === "reminder" || entry.entryType === "project_instructions") {
    return entry.payload.message;
  }
  throw new Error(`entry has no model message: ${entry.entryType}`);
}
