import { createHash } from "node:crypto";

import type { ModelMessage, ModelUsage } from "@laohuang/llm";
import type { ToolSpec } from "@laohuang/tools";
import type { SessionEntry } from "@laohuang/session-store";

export interface UsageAnchor {
  readonly throughEntryId: string;
  readonly throughSeq: number;
  readonly contextTokens: number;
  readonly provider: string;
  readonly model: string;
  readonly systemFingerprint: string;
  readonly projectInstructionsFingerprint: string;
  readonly toolsFingerprint: string;
}

export interface TokenMeasurement {
  readonly totalTokens: number;
  readonly anchorTokens: number;
  readonly trailingTokens: number;
  readonly source: "provider_usage" | "estimated";
}

export interface TokenMeasurementInput {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly entries: readonly SessionEntry[];
  readonly anchor?: UsageAnchor | null;
  readonly provider: string;
  readonly model: string;
  readonly systemFingerprint: string;
  readonly projectInstructionsFingerprint: string;
  readonly toolsFingerprint: string;
}

export interface TokenEstimator {
  estimateMessages(messages: readonly ModelMessage[]): number;
  estimateTools(tools: readonly ToolSpec[]): number;
  estimateText(text: string): number;
  measure(input: TokenMeasurementInput): TokenMeasurement;
}

const TEXT_BYTES_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const MESSAGE_OVERHEAD = 4;

export class DefaultTokenEstimator implements TokenEstimator {
  estimateMessages(messages: readonly ModelMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateMessage(message), 0);
  }

  estimateTools(tools: readonly ToolSpec[]): number {
    if (tools.length === 0) {
      return 0;
    }
    return this.estimateText(canonicalJson(tools)) + BLOCK_OVERHEAD;
  }

  estimateText(text: string): number {
    return Math.ceil(Buffer.byteLength(text, "utf8") / TEXT_BYTES_PER_TOKEN);
  }

  measure(input: TokenMeasurementInput): TokenMeasurement {
    const anchor = input.anchor ?? null;
    if (anchor !== null && this.isValidAnchor(input, anchor)) {
      const trailingEntries = input.entries.filter((entry) => entry.seq > anchor.throughSeq);
      const trailingTokens = this.estimateMessages(messagesForEntries(trailingEntries));
      return {
        totalTokens: anchor.contextTokens + trailingTokens,
        anchorTokens: anchor.contextTokens,
        trailingTokens,
        source: "provider_usage",
      };
    }
    const totalTokens = this.estimateMessages(input.messages) + this.estimateTools(input.tools);
    return {
      totalTokens,
      anchorTokens: 0,
      trailingTokens: totalTokens,
      source: "estimated",
    };
  }

  private estimateMessage(message: ModelMessage): number {
    if (message.role === "system" || message.role === "user") {
      return MESSAGE_OVERHEAD + BLOCK_OVERHEAD + this.estimateText(message.content);
    }
    if (message.role === "tool-result") {
      return MESSAGE_OVERHEAD + BLOCK_OVERHEAD + this.estimateText(message.content);
    }
    return MESSAGE_OVERHEAD + message.content.reduce((total, block) => {
      if (block.type === "text" || block.type === "reasoning") {
        return total + BLOCK_OVERHEAD + this.estimateText(block.text);
      }
      return total + BLOCK_OVERHEAD + this.estimateText(
        `${block.call.name}${canonicalJson(block.call.arguments)}`,
      );
    }, 0);
  }

  private isValidAnchor(input: TokenMeasurementInput, anchor: UsageAnchor): boolean {
    return anchor.provider === input.provider &&
      anchor.model === input.model &&
      anchor.systemFingerprint === input.systemFingerprint &&
      anchor.projectInstructionsFingerprint === input.projectInstructionsFingerprint &&
      anchor.toolsFingerprint === input.toolsFingerprint &&
      input.entries.some((entry) => entry.id === anchor.throughEntryId && entry.seq === anchor.throughSeq);
  }
}

export function normalizeProviderUsage(usage: ModelUsage): number {
  return usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    usage.outputTokens;
}

export function fingerprintContextPart(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortStable(value));
}

function sortStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortStable);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortStable(record[key]);
    }
    return sorted;
  }
  return value;
}

function messagesForEntries(entries: readonly SessionEntry[]): readonly ModelMessage[] {
  return entries.flatMap((entry): ModelMessage[] => {
    if (entry.entryType === "system_context") {
      return [entry.payload.message];
    }
    if (entry.entryType === "project_instructions" || entry.entryType === "user_message" || entry.entryType === "reminder") {
      return [entry.payload.message];
    }
    if (entry.entryType === "assistant_message") {
      return [entry.payload.message];
    }
    if (entry.entryType === "tool_result") {
      return [entry.payload.message];
    }
    return [];
  });
}
