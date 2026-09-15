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
  const skillNames = new Map<string, string>();
  for (const entry of entries) {
    if (entry.entryType === "user_message") {
      items.push({ kind: "user", text: entry.payload.message.skillContext?.input ?? entry.payload.message.content });
    } else if (entry.entryType === "assistant_message") {
      for (const block of entry.payload.message.content) {
        if (block.type !== "tool-call" || block.call.name !== "skill") continue;
        try {
          const args: unknown = JSON.parse(block.call.arguments);
          if (args && typeof args === "object" && "name" in args && typeof args.name === "string") {
            skillNames.set(block.call.id, args.name);
          }
        } catch { /* Malformed arguments remain visible through the tool failure. */ }
      }
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
      const message = entry.payload.message;
      let result = message.content;
      if (message.toolName === "skill") {
        try {
          const value: unknown = JSON.parse(result);
          if (value && typeof value === "object") {
            if ("content" in value && typeof value.content === "string") result = value.content;
            else if ("error" in value && typeof value.error === "string") result = value.error;
          }
        } catch { /* Keep unstructured results readable. */ }
      }
      items.push({
        kind: "tool",
        callId: entry.payload.message.toolCallId,
        name: entry.payload.message.toolName,
        subject: message.toolName === "skill" ? skillNames.get(message.toolCallId) ?? "" : message.toolCallId,
        result,
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
