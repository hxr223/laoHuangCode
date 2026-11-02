import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEMODE_LIMITS, type CodeModeResult } from "@laohuang/codemode";
import type { ToolResult } from "@laohuang/tools";
import { assertAttachmentContent, type AttachmentContent } from "@laohuang/attachment";
import type { CodeModeImagePort } from "./images.ts";

export async function renderCodeModeOutput(result: CodeModeResult, options: {
  maxOutputTokens?: number; outputDirectory: string; images: Pick<CodeModeImagePort, "resolve">; signal?: AbortSignal;
}): Promise<ToolResult> {
  const text: string[] = [];
  const attachments: AttachmentContent[] = [];
  let mediaFailure: string | undefined;
  for (const item of result.output) {
    if (item.type === "text") { text.push(item.text); continue; }
    try {
      const attachment = await options.images.resolve(item, options.signal);
      assertAttachmentContent(attachment);
      if (attachment.type !== "image") throw new Error("Code Mode image resolver returned a non-image attachment");
      attachments.push(attachment);
    } catch (error) {
      mediaFailure = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  if (mediaFailure === undefined && result.ok && result.value !== undefined) text.push(typeof result.value === "string" ? result.value : JSON.stringify(result.value));
  const tokens = options.maxOutputTokens ?? 10000;
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new RangeError("Invalid Code Mode output token budget");
  const budget = Math.min(CODEMODE_LIMITS.outputChars, tokens * 4);
  const chars = text.reduce((sum, part) => sum + part.length, 0) + Math.max(0, text.length - 1);
  const error = mediaFailure !== undefined ? mediaFailure : !result.ok ? `${result.error.message}${result.error.stack ? `\n${result.error.stack}` : ""}` : undefined;
  const base: ToolResult = { ok: result.ok && mediaFailure === undefined,
    status: mediaFailure !== undefined ? "failed" : result.ok ? "completed" : result.error.kind === "aborted" ? "cancelled" : result.error.kind === "timeout" ? "timeout" : "failed",
    ...(attachments.length ? { attachmentContent: attachments } : {}),
    ...(error !== undefined ? { error: error.slice(0, 4000) } : {}) };
  if (chars <= budget) return { ...base, content: text.join("\n") };
  let path: string | undefined;
  let note: string;
  try {
    path = await saveOutput(text, options.outputDirectory);
    note = `\n[Output truncated. Full output: ${JSON.stringify(path)}]\n`;
  } catch {
    note = "\n[Output truncated. Full output could not be saved.]\n";
  }
  const available = Math.max(0, budget - note.length);
  const head = Math.ceil(available / 2);
  const tail = available - head;
  const content = note.length >= budget ? note.slice(0, budget)
    : sliceOutput(text, 0, head) + note + sliceOutput(text, chars - tail, chars);
  return { ...base, content, truncated: true, ...(path ? { path } : {}) };
}

function sliceOutput(parts: readonly string[], start: number, end: number): string {
  const selected: string[] = [];
  let position = 0;
  for (const [index, part] of parts.entries()) {
    if (index) {
      if (position >= start && position < end) selected.push("\n");
      position++;
    }
    const from = Math.max(0, start - position);
    const through = Math.min(part.length, end - position);
    if (through > from) selected.push(part.slice(from, through));
    position += part.length;
    if (position >= end) break;
  }
  return selected.join("");
}

async function saveOutput(parts: readonly string[], directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `codemode-${randomUUID()}.txt`);
  const file = await open(path, "wx", 0o600);
  try {
    // Avoid constructing a second full-size joined output string.
    async function* chunks(): AsyncGenerator<string> {
      for (const [index, part] of parts.entries()) { if (index) yield "\n"; yield part; }
    }
    await file.writeFile(chunks(), { encoding: "utf8" });
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  return path;
}
