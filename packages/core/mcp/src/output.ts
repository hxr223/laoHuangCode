import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResult } from "@laohuang/tools";
import type { McpToolResult } from "./types.ts";

/** Limit the actual model payload, including JSON escaping and metadata. */
function bounded(result: ToolResult, limit: number): ToolResult {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= limit) return result;
  const content = result.content ?? "";
  let low = 0;
  let high = content.length;
  result = { ...result, content: "", truncated: true };
  if (Buffer.byteLength(JSON.stringify(result)) > limit) {
    return { ok: false, status: "output_storage_failed", remoteCompleted: true, error: "MCP output metadata exceeds limit; do not replay the operation." };
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify({ ...result, content: content.slice(0, middle) })) <= limit) low = middle;
    else high = middle - 1;
  }
  return { ...result, content: content.slice(0, low) };
}

export async function adaptMcpResult(result: McpToolResult, options: { artifactRoot: string; maxBytes?: number }): Promise<ToolResult> {
  const limit = options.maxBytes ?? 51200;
  if (!Number.isInteger(limit) || limit < 512) throw new Error("Invalid MCP output limit");
  const { _meta: _protocolMetadata, ...business } = result;
  const content: string[] = [];
  const media: { data: string; mimeType: string }[] = [];
  if ("content" in result && Array.isArray(result.content)) {
    for (const block of result.content) {
      switch (block.type) {
        case "text": content.push(block.text); break;
        case "image": case "audio":
          media.push({ data: block.data, mimeType: block.mimeType });
          content.push(`[${block.type} attachment: ${block.mimeType}; not native model input]`);
          break;
        case "resource_link": content.push(JSON.stringify(block)); break;
        case "resource":
          if ("text" in block.resource) content.push(JSON.stringify(block));
          else media.push({ data: block.resource.blob, mimeType: block.resource.mimeType ?? "application/octet-stream" });
          break;
        default: content.push(JSON.stringify(block));
      }
    }
  } else content.push(JSON.stringify(business));
  if ("structuredContent" in result && result.structuredContent !== undefined) content.push(JSON.stringify(result.structuredContent));
  const ok = !("isError" in result && result.isError === true);
  const preview: ToolResult = { ok, status: ok ? "completed" : "failed", content: content.join("\n") };
  const oversized = Buffer.byteLength(JSON.stringify(preview)) > limit;
  if (!oversized && media.length === 0) return preview;
  try {
    const directory = join(options.artifactRoot, randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "result.json");
    await writeFile(path, JSON.stringify(business), { mode: 0o600, flag: "wx" });
    const attachments: { path: string; mimeType: string }[] = [];
    for (const [index, item] of media.entries()) {
      const path = join(directory, `attachment-${index}.bin`);
      const decoded = Buffer.from(item.data, "base64");
      if (decoded.toString("base64").replace(/=+$/, "") !== item.data.replace(/=+$/, "")) throw new Error("Invalid base64 attachment");
      await writeFile(path, decoded, { mode: 0o600, flag: "wx" });
      attachments.push({ path, mimeType: item.mimeType });
    }
    return bounded({ ...preview, path, attachments, truncated: oversized,
      note: "Full business result: read result.json. For a long single line, use bash to read byte ranges. Media attachments are files, not native model input." }, limit);
  } catch {
    return bounded({ ...preview, ok: false, status: "output_storage_failed", remoteCompleted: true,
      error: "Remote operation completed but its full output could not be saved. Do not replay the operation." }, limit);
  }
}
