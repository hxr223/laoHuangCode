import { readFileSync } from "node:fs";

import {
  SessionSchemaError,
  parseSessionHeader,
  parseSessionItem,
  type SessionHeader,
  type SessionItem,
} from "./schema.ts";

export interface OpenToolCall {
  readonly entryId: string;
  readonly seq: number;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface SessionReplay {
  readonly header: SessionHeader;
  readonly items: readonly SessionItem[];
  readonly lastSeq: number;
  readonly ignoredTornTail: boolean;
  readonly openToolCalls: readonly OpenToolCall[];
}

export class SessionCorruptError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, message: string, options: { cause?: unknown } = {}) {
    super(
      `${path}:${line}: ${message}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SessionCorruptError";
    this.path = path;
    this.line = line;
  }
}

export function readSessionFile(path: string): SessionReplay {
  const text = readFileSync(path, "utf8");
  const endsWithNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (endsWithNewline) {
    rawLines.pop();
  }
  if (rawLines.length === 0 || rawLines[0] === "") {
    throw new SessionCorruptError(path, 1, "missing session header");
  }
  const header = parseLine(path, 1, rawLines[0]!, parseSessionHeader);
  const items: SessionItem[] = [];
  let ignoredTornTail = false;
  let previousSeq = 0;
  for (let index = 1; index < rawLines.length; index += 1) {
    const lineNumber = index + 1;
    const line = rawLines[index]!;
    if (line.trim() === "") {
      continue;
    }
    try {
      const item = parseSessionItem(JSON.parse(line), header.sessionId);
      if (item.seq !== previousSeq + 1) {
        throw new SessionSchemaError("session item seq must be contiguous");
      }
      previousSeq = item.seq;
      items.push(item);
    } catch (error) {
      if (!endsWithNewline && index === rawLines.length - 1) {
        ignoredTornTail = true;
        break;
      }
      throw corrupt(path, lineNumber, error);
    }
  }
  return {
    header,
    items,
    lastSeq: previousSeq,
    ignoredTornTail,
    openToolCalls: findOpenToolCalls(items),
  };
}

function parseLine<T>(
  path: string,
  line: number,
  raw: string,
  parse: (value: unknown) => T,
): T {
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    throw corrupt(path, line, error);
  }
}

function corrupt(path: string, line: number, error: unknown): SessionCorruptError {
  if (error instanceof SessionCorruptError) {
    return error;
  }
  return new SessionCorruptError(
    path,
    line,
    error instanceof Error ? error.message : "invalid session JSONL",
    { cause: error },
  );
}

function findOpenToolCalls(items: readonly SessionItem[]): readonly OpenToolCall[] {
  const calls = new Map<string, OpenToolCall>();
  for (const item of items) {
    if (item.kind === "entry" && item.entryType === "assistant_message") {
      for (const block of item.payload.message.content) {
        if (block.type === "tool-call") {
          calls.set(block.call.id, {
            entryId: item.id,
            seq: item.seq,
            toolCallId: block.call.id,
            toolName: block.call.name,
          });
        }
      }
    }
    if (item.kind === "entry" && item.entryType === "tool_result") {
      calls.delete(item.payload.message.toolCallId);
    }
  }
  return [...calls.values()];
}
