import type { SessionItem } from "./schema.ts";

export function normalizeSessionTitle(input: string): string {
  if (/\p{Cc}|\u2028|\u2029/u.test(input)) {
    throw new Error("Session name must be a single line without control characters.");
  }
  const title = input.trim();
  if (title.length === 0) {
    throw new Error("Session name must not be empty.");
  }
  return title;
}

export function sessionTitleAt(
  items: readonly SessionItem[],
  throughSeq: number = Infinity,
): string | null {
  let title: string | null = null;
  for (const item of items) {
    if (item.seq > throughSeq) {
      break;
    }
    if (item.kind === "record" && item.recordType === "session_name_changed") {
      const value = item.payload["title"];
      if (typeof value !== "string") {
        throw new Error("Invalid session name record.");
      }
      title = normalizeSessionTitle(value);
    }
  }
  return title;
}
