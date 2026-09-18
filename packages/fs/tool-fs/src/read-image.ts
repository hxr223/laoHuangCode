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
      description: "View a PNG, JPEG, WebP or GIF from a local path or an image attachment ID in this session. Optional crop coordinates use the oriented original pixels. Animations show only their first frame. full_resolution prevents downscaling and may exceed model limits.",
      parameters: { type: "object", properties: {
        path: { type: "string" }, attachment_id: { type: "string" },
        region: { type: "object", properties: {
          x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
          width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 },
        }, required: ["x", "y", "width", "height"], additionalProperties: false },
        full_resolution: { type: "boolean" },
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
