import type { ModelMessage, ModelUsage } from "@laohuang/llm";
import type { SessionEntry } from "@laohuang/session-store";

import { normalizeProviderUsage } from "./token-estimator.ts";

/** Display occupancy, independent of the governor's full request budget. */
export class ContextUsage {
  #tokens: number | null = 0;

  constructor(entries: readonly SessionEntry[] = []) {
    for (const entry of entries) this.append(entry);
  }

  get tokens(): number | null {
    return this.#tokens;
  }

  /** Histories are append-only and ordered; process each committed entry once. */
  append(entry: SessionEntry): void {
    if (entry.entryType === "compaction") {
      this.#tokens = null;
      return;
    }
    if (entry.entryType === "assistant_message") {
      const usage = validUsageTokens(entry.payload.usage);
      if (usage !== null) {
        this.#tokens = usage;
        return;
      }
    }
    if (this.#tokens === null) return;
    if (entry.entryType === "user_message" || entry.entryType === "assistant_message" ||
      entry.entryType === "tool_result" || entry.entryType === "reminder") {
      this.#tokens += estimateMessage(entry.payload.message);
    }
  }
}

function validUsageTokens(usage: ModelUsage | undefined): number | null {
  if (usage === undefined || usage === null) return null;
  const fields = [usage.inputTokens, usage.outputTokens,
    usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (!fields.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = normalizeProviderUsage(usage);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function estimateMessage(message: ModelMessage): number {
  if (message.role === "system") return 0;
  if (message.role !== "assistant") return Math.ceil(message.content.length / 4);
  const chars = message.content.reduce((sum, block) => {
    if (block.type === "tool-call") {
      return sum + block.call.name.length + JSON.stringify(block.call.arguments).length;
    }
    return sum + block.text.length;
  }, 0);
  return Math.ceil(chars / 4);
}
