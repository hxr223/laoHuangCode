import type { SessionEntry } from "./schema.ts";

export type RestoredTranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string; readonly reasoning?: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly subject: string;
      readonly result: string;
      readonly isError: boolean;
    }
  | { readonly kind: "notice"; readonly text: string; readonly tone: "info" | "warning" | "error" };

export function projectTranscript(
  entries: readonly SessionEntry[],
): readonly RestoredTranscriptItem[] {
  const items: RestoredTranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.entryType === "user_message") {
      items.push({ kind: "user", text: entry.payload.message.content });
    } else if (entry.entryType === "assistant_message") {
      const text = entry.payload.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const reasoning = entry.payload.message.content
        .filter((block) => block.type === "reasoning")
        .map((block) => block.text)
        .join("");
      items.push({
        kind: "assistant",
        text,
        ...(reasoning === "" ? {} : { reasoning }),
      });
    } else if (entry.entryType === "tool_result") {
      items.push({
        kind: "tool",
        callId: entry.payload.message.toolCallId,
        name: entry.payload.message.toolName,
        subject: entry.payload.message.toolCallId,
        result: entry.payload.message.content,
        isError: entry.payload.message.isError,
      });
    } else if (entry.entryType === "compaction") {
      items.push({
        kind: "notice",
        text: "Conversation context was compacted.",
        tone: "info",
      });
    }
  }
  return items;
}
