import { assertAttachmentContent, type AttachmentStore, type ImageTarget } from "@laohuang/attachment";
import { ModelError, type ModelRequest, type ModelMessage } from "@laohuang/llm";
import type { Api, Model, TextContent, ImageContent } from "@earendil-works/pi-ai";

export interface ImageRequestPolicy {
  readonly target: ImageTarget;
  readonly maxImages: number;
  /** Total encoded binary bytes, before Base64 expansion. */
  readonly maxTotalBytes: number;
}
export interface ImagePreparationOptions {
  readonly store: () => AttachmentStore | undefined;
  readonly policy?: (model: Model<Api>) => ImageRequestPolicy;
}

/** Application budgets, not claims about every provider's maximum accepted limits. */
export function defaultImagePolicy(model: Model<Api>): ImageRequestPolicy {
  const anthropic = model.api === "anthropic-messages";
  const google = model.api === "google-generative-ai" || model.api === "google-vertex";
  return {
    target: { maxPixels: anthropic ? 1_150_000 : google ? 4_194_304 : 2_097_152,
      maxDimension: anthropic ? 1568 : 2048, maxBytes: 4 * 1024 ** 2,
      formats: ["image/png", "image/jpeg", "image/webp"] },
    maxImages: 20, maxTotalBytes: (google ? 12 : 16) * 1024 ** 2,
  };
}

export async function prepareRequestImages(request: ModelRequest, model: Model<Api>, options?: ImagePreparationOptions) {
  const offloaded = request.imageContext?.offloaded ?? new Set<string>();
  // Keep source indexes stable when an earlier image in the same message is offloaded.
  const blocks = new Map<ModelMessage, Array<TextContent | ImageContent>>();
  const images: Array<{ key: string; owner: ModelMessage; content: ImageContent; note: TextContent; bytes: number }> = [];
  const policy = (options?.policy ?? defaultImagePolicy)(model);
  if (![policy.maxImages, policy.maxTotalBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new ModelError("Invalid image request budget", { kind: "protocol" });
  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "tool-result") continue;
    const output: Array<TextContent | ImageContent> = [];
    blocks.set(message, output);
    for (const [index, block] of (message.attachments ?? []).entries()) {
      assertAttachmentContent(block);
      if (block.type === "file") {
        output.push({ type: "text", text: `Attached file ${JSON.stringify(block.ref.name)} (${block.ref.id}, ${block.ref.bytes} bytes). File bytes have not been read or parsed.` });
        continue;
      }
      const key = `${message.attachmentKey}:${index}`;
      if (offloaded.has(key) || message.omittedImageIndexes?.includes(index)) { output.push({ type: "text", text: `[Image ${block.ref.id} omitted from context; use read_image to inspect it again.]` }); continue; }
      if (!model.input.includes("image")) throw new ModelError(`Model ${model.provider}/${model.id} does not declare image input`, { kind: "protocol" });
      const store = options?.store();
      if (!store) throw new ModelError("Image request requires an attachment store", { kind: "protocol" });
      const prepared = await store.prepareImage(block.ref, { ...policy.target, ...block.view }, request.cancelToken?.signal);
      const content: ImageContent = { type: "image", data: Buffer.from(prepared.data).toString("base64"), mimeType: prepared.mimeType };
      const note: TextContent = { type: "text", text: `Image ${block.ref.id}: ${prepared.note}` };
      output.push(note, content);
      images.push({ key, owner: message, content, note, bytes: prepared.data.byteLength });
    }
  }
  let count = images.length;
  let bytes = images.reduce((sum, image) => sum + image.bytes, 0);
  const evicted: string[] = [];
  for (const image of images) {
    if (count <= policy.maxImages && bytes <= policy.maxTotalBytes) break;
    if (!request.imageContext || request.imageContext.protectedKeys.has(image.key) || !("attachmentKey" in image.owner) || !image.owner.attachmentKey) continue;
    const output = blocks.get(image.owner)!;
    output.splice(output.indexOf(image.content), 1);
    image.note.text = `[Image omitted from context to meet request budget; original remains stored. Use read_image to inspect it again.]`;
    evicted.push(image.key);
    count--; bytes -= image.bytes;
  }
  if (count > policy.maxImages || bytes > policy.maxTotalBytes) throw new ModelError("Current-turn images exceed the request image budget; reduce the number or crop the images", { kind: "protocol" });
  request.cancelToken?.signal.throwIfAborted();
  if (evicted.length) request.imageContext!.persistOffload(evicted);
  return blocks;
}
