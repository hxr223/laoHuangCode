import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertAttachmentContent, type AttachmentId } from "@laohuang/attachment";
import { readSessionFile } from "./session-reader.ts";
import type { SessionEntry } from "./schema.ts";

export function attachmentReferences(entries: readonly SessionEntry[]): ReadonlySet<AttachmentId> {
  const result = new Set<AttachmentId>();
  for (const entry of entries) {
    if (entry.entryType === "compaction" || entry.entryType === "image_offload" || entry.entryType === "context_reset") continue;
    if (!("message" in entry.payload) || !entry.payload.message || typeof entry.payload.message !== "object") throw new Error("Incomplete session message during attachment scan");
    const message = entry.payload.message;
    if (!("attachments" in message)) continue;
    for (const block of message.attachments ?? []) {
      assertAttachmentContent(block);
      result.add(block.ref.id);
    }
  }
  return result;
}

/** Fail closed: never use the UI's best-effort/corrupt-session listing for GC. */
export function scanAttachmentReferences(sessionsRoot: string): ReadonlySet<AttachmentId> {
  const result = new Set<AttachmentId>();
  const visit = (directory: string): void => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isSymbolicLink()) throw new Error(`Cannot scan symbolic session path: ${path}`);
      if (file.isDirectory()) visit(path);
      else if (file.name.endsWith(".jsonl")) {
        if (!lstatSync(path).isFile()) throw new Error(`Invalid session file: ${path}`);
        const replay = readSessionFile(path);
        if (replay.ignoredTornTail) throw new Error(`Incomplete session journal: ${path}`);
        for (const id of attachmentReferences(replay.items.filter(item => item.kind === "entry"))) result.add(id);
      }
    }
  };
  visit(sessionsRoot);
  return result;
}
