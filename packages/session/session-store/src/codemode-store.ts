import type { SessionEntry } from "./schema.ts";
import type { CodeModeResultMetadata } from "@laohuang/tools";
import { assertAttachmentContent } from "@laohuang/attachment";

const STORE_VALUE_CHARS = 262144;
const STORE_TOTAL_CHARS = 1048576;

/** Validate a delta against the latest committed state before the journal writes it. */
export function mergeCodeModeStore(initial: Readonly<Record<string, unknown>>, writes: NonNullable<CodeModeResultMetadata["storeWrites"]>): Readonly<Record<string, unknown>> {
  const next = new Map(Object.entries(initial));
  for (const key of writes.delete) next.delete(key);
  for (const [key, value] of Object.entries(writes.set)) next.set(key, value);
  if ([...next].reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0) > STORE_TOTAL_CHARS) throw new RangeError("Committed store exceeds total capacity");
  return JSON.parse(JSON.stringify(Object.fromEntries(next))) as Record<string, unknown>;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

export function assertCodeModeMetadata(value: unknown, allowStoreWrites: boolean): asserts value is CodeModeResultMetadata {
  const metadata = objectOf(value, "code mode metadata");
  if (metadata.storeWrites !== undefined) {
    if (!allowStoreWrites) throw new Error("Store writes require a successful root result");
    const writes = objectOf(metadata.storeWrites, "store writes");
    const set = objectOf(writes.set, "store set");
    if (!Array.isArray(writes.delete) || writes.delete.some(key => typeof key !== "string") || new Set(writes.delete).size !== writes.delete.length) throw new TypeError("Invalid store delete keys");
    let chars = 0;
    for (const [key, item] of Object.entries(set)) {
      if (writes.delete.includes(key)) throw new TypeError("Conflicting store writes");
      const json = JSON.stringify(item);
      if (json === undefined || json.length > STORE_VALUE_CHARS) throw new RangeError("Invalid store value size");
      chars += key.length + json.length;
    }
    if (chars > STORE_TOTAL_CHARS) throw new RangeError("Store writes exceed total capacity");
  }
  if (metadata.internalAttachments !== undefined) {
    if (!Array.isArray(metadata.internalAttachments)) throw new TypeError("Invalid code mode attachment metadata");
    for (const attachment of metadata.internalAttachments) assertAttachmentContent(attachment);
  }
}

/** Rebuild state from the branch's committed journal, independently of model compaction. */
export function projectCodeModeStore(entries: readonly SessionEntry[]): Readonly<Record<string, unknown>> {
  const state = new Map<string, string>();
  let chars = 0;
  for (const entry of entries) {
    if (entry.entryType !== "tool_result") continue;
    if (entry.payload.codeMode !== undefined) assertCodeModeMetadata(entry.payload.codeMode, !entry.payload.message.isError && !entry.payload.recovered);
    const writes = entry.payload.codeMode?.storeWrites;
    if (!writes) continue;
    for (const key of writes.delete) {
      const previous = state.get(key);
      if (previous !== undefined) chars -= key.length + previous.length;
      state.delete(key);
    }
    for (const [key, value] of Object.entries(writes.set)) {
      const previous = state.get(key);
      if (previous !== undefined) chars -= key.length + previous.length;
      const json = JSON.stringify(value);
      state.set(key, json);
      chars += key.length + json.length;
    }
    if (chars > STORE_TOTAL_CHARS) throw new RangeError("Committed store exceeds total capacity");
  }
  return Object.fromEntries([...state].map(([key, json]) => [key, JSON.parse(json) as unknown]));
}
