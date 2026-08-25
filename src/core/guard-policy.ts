import type { AssembledToolCall } from "../model-stream.ts";
import type { ToolResult } from "../tools.ts";

export interface GuardPolicyOptions {
  maxTotalTokens: number;
  maxElapsedSeconds: number;
  repeatedToolCallLimit: number;
}

export interface RepeatedToolCall {
  name: string;
  count: number;
}

/** Owns token, elapsed-time, and repeated-tool-call safety decisions. */
export class GuardPolicy {
  private readonly maxTotalTokens: number;
  private readonly maxElapsedSeconds: number;
  private readonly repeatedToolCallLimit: number;
  private readonly repeatedCalls = new Map<string, number>();

  constructor(options: GuardPolicyOptions) {
    this.maxTotalTokens = options.maxTotalTokens;
    this.maxElapsedSeconds = options.maxElapsedSeconds;
    this.repeatedToolCallLimit = options.repeatedToolCallLimit;
  }

  budgetReason(totalTokens: number, elapsedSeconds: number): string | null {
    if (totalTokens >= this.maxTotalTokens) {
      return `token budget reached (${this.maxTotalTokens})`;
    }
    if (elapsedSeconds >= this.maxElapsedSeconds) {
      return `elapsed time budget reached (${String(this.maxElapsedSeconds)} seconds)`;
    }
    return null;
  }

  recordRepeatedToolCalls(
    toolCalls: readonly AssembledToolCall[],
    toolResults: readonly ToolResult[],
  ): RepeatedToolCall | null {
    let repeated: RepeatedToolCall | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index];
      if (toolCall === undefined) {
        continue;
      }
      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(toolCall.function.arguments);
      } catch {
        parsedArguments = toolCall.function.arguments;
      }
      const fingerprint = stableStringify({
        name: toolCall.function.name,
        arguments: parsedArguments,
        result: stableToolResult(toolResults[index]),
      });
      const count = (this.repeatedCalls.get(fingerprint) ?? 0) + 1;
      this.repeatedCalls.set(fingerprint, count);
      seen.add(fingerprint);
      if (repeated === null || count > repeated.count) {
        repeated = { name: toolCall.function.name, count };
      }
    }
    for (const fingerprint of [...this.repeatedCalls.keys()]) {
      if (!seen.has(fingerprint)) {
        this.repeatedCalls.delete(fingerprint);
      }
    }
    return repeated !== null && repeated.count >= this.repeatedToolCallLimit
      ? repeated
      : null;
  }
}

function stableToolResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableToolResult(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key !== "duration_ms") {
        result[key] = stableToolResult(item);
      }
    }
    return result;
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value));
}
