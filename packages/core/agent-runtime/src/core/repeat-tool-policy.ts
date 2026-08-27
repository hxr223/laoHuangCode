import type { ToolCall, ToolResult } from "@laohuang/tools";

export interface RepeatedToolCall {
  name: string;
  count: number;
}

/** Detects consecutive identical tool calls at configured reminder thresholds. */
export class RepeatToolPolicy {
  private readonly reminderThresholds: ReadonlySet<number>;
  private readonly repeatedCalls = new Map<string, number>();

  constructor(reminderThresholds: readonly number[]) {
    this.reminderThresholds = new Set(reminderThresholds);
  }

  record(
    toolCalls: readonly ToolCall[],
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
        parsedArguments = JSON.parse(toolCall.arguments);
      } catch {
        parsedArguments = toolCall.arguments;
      }
      const fingerprint = stableStringify({
        name: toolCall.name,
        arguments: parsedArguments,
        result: stableToolResult(toolResults[index]),
      });
      const count = (this.repeatedCalls.get(fingerprint) ?? 0) + 1;
      this.repeatedCalls.set(fingerprint, count);
      seen.add(fingerprint);
      if (repeated === null || count > repeated.count) {
        repeated = { name: toolCall.name, count };
      }
    }
    for (const fingerprint of [...this.repeatedCalls.keys()]) {
      if (!seen.has(fingerprint)) {
        this.repeatedCalls.delete(fingerprint);
      }
    }
    return repeated !== null && this.reminderThresholds.has(repeated.count)
      ? repeated
      : null;
  }
}

export function repeatToolReminder(repeated: RepeatedToolCall): string {
  return `<system-reminder>Tool ${JSON.stringify(repeated.name)} has been called ` +
    `${repeated.count} consecutive times with the same arguments and result. ` +
    "Reconsider the approach before repeating it again. Tool use remains available." +
    "</system-reminder>";
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
