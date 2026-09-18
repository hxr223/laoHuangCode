import { open } from "node:fs/promises";
import { basename } from "node:path";
import { assertImageView, AttachmentError, type AttachmentStore, type ImageRef } from "@laohuang/attachment";
import { resolveLocalPath, type LocalPathOptions } from "@laohuang/local-paths";
import { cancelledResult, withTouchedPath, type ToolAdapterDefinition } from "@laohuang/tools";

export function createReadImageTool(options: {
  readonly store: AttachmentStore;
  readonly projectRoot: string;
  readonly pathOptions?: LocalPathOptions;
  /** Resolve only images formally referenced by the current session. */
  readonly resolveReference: (id: string) => ImageRef | undefined;
}): ToolAdapterDefinition {
  return {
    spec: {
      name: "read_image",
      description: "View a PNG, JPEG, WebP or GIF image. Use path to read a local image file. " +
        "Use attachment_id only to re-read an image attachment reference already returned in the current session; do not guess IDs. " +
        "Provide exactly one of path or attachment_id. Optional crop coordinates use the oriented original pixels. " +
        "Animations show only their first frame. full_resolution prevents downscaling and may exceed model limits.",
      parameters: { type: "object", properties: {
        path: {
          type: "string",
          description: "Local image file path. Absolute paths are accepted; relative paths resolve against the default working directory, and ~/ expands to the user's home directory. Use this for local files. Provide exactly one of path or attachment_id.",
        },
        attachment_id: {
          type: "string",
          description: "Exact image attachment ID (sha256:...) already returned in the current session. Use only to re-read an existing session attachment, not to locate a local file. Do not guess IDs. Images not referenced by the current session are rejected. Provide exactly one of path or attachment_id.",
        },
        region: { type: "object",
          description: "Optional rectangle in original-image pixels after orientation correction, with the origin at the top-left. Omit to view the whole image. Use a crop to inspect details that are unclear in a downscaled view. Out-of-bounds regions are rejected, not clipped. The crop may still be downscaled unless full_resolution is true.",
          properties: {
          x: { type: "integer", minimum: 0, description: "Zero-based left edge in the oriented original image, in pixels." },
          y: { type: "integer", minimum: 0, description: "Zero-based top edge in the oriented original image, in pixels." },
          width: { type: "integer", minimum: 1, description: "Crop width in original-image pixels; must be positive." },
          height: { type: "integer", minimum: 1, description: "Crop height in original-image pixels; must be positive." },
        }, required: ["x", "y", "width", "height"], additionalProperties: false },
        full_resolution: {
          type: "boolean",
          description: "Defaults to false: the whole image or crop may be downscaled to fit model request limits. Set true to preserve its pixel dimensions; orientation correction and re-encoding may still occur. If model limits cannot be met, request preparation fails instead of silently downscaling. Use a smaller region in that case.",
        },
      }, additionalProperties: false },
      promptGuidelines: ["Use read_image for visual image inspection. Use read for text. Image crop coordinates refer to the oriented original; follow the returned coordinate mapping."],
    },
    async execute(args, execution) {
      if ((typeof args.path === "string") === (typeof args.attachment_id === "string")) throw new Error("Supply exactly one of path or attachment_id");
      const view = { ...(args.region === undefined ? {} : { region: args.region }), ...(args.full_resolution === undefined ? {} : { fullResolution: args.full_resolution }) };
      assertImageView(view);
      const release = options.store.protect();
      try {
        let ref: ImageRef;
        let target: string | undefined;
        if (typeof args.path === "string") {
          target = resolveLocalPath(args.path, options.projectRoot, options.pathOptions);
          const handle = await open(target, "r");
          let bytes: Buffer;
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > options.store.imageLimits.maxBytes) throw new AttachmentError("LIMIT_EXCEEDED", "Image must be a regular file within the source byte limit");
            const chunks: Buffer[] = [];
            let total = 0;
            while (true) {
              execution.signal?.throwIfAborted();
              const buffer = Buffer.allocUnsafe(64 * 1024);
              const { bytesRead } = await handle.read(buffer);
              if (!bytesRead) break;
              total += bytesRead;
              if (total > options.store.imageLimits.maxBytes) throw new AttachmentError("LIMIT_EXCEEDED", "Image exceeds source byte limit");
              chunks.push(buffer.subarray(0, bytesRead));
            }
            bytes = Buffer.concat(chunks);
          } finally { await handle.close(); }
          ref = (await options.store.saveImages([{ data: bytes, name: basename(target) }], execution.signal))[0]!;
        } else {
          const found = options.resolveReference(String(args.attachment_id));
          if (!found) throw new AttachmentError("ACCESS_DENIED", "Image is not referenced by the current session");
          ref = found;
          for await (const _chunk of options.store.readFile(ref, execution.signal)) { /* Verify the complete original. */ }
        }
        if (view.region && (view.region.x + view.region.width > ref.width || view.region.y + view.region.height > ref.height)) throw new AttachmentError("LIMIT_EXCEEDED", "Crop is outside the oriented image");
        if (execution.isCancelled()) return cancelledResult(execution);
        const result = { ok: true, content: `Image ${ref.id}, oriented original ${ref.width}x${ref.height}.`, attachmentContent: [{ type: "image" as const, ref, view }] };
        return target ? withTouchedPath(result, target) : result;
      } finally { release(); }
    },
  };
}
