import { assertAttachmentContent, assertImageView, AttachmentError, type AttachmentContent, type AttachmentStore } from "@laohuang/attachment";
import type { CodeModeImageSource } from "@laohuang/codemode";

export interface CodeModeImagePort {
  remember(attachments: readonly AttachmentContent[]): void;
  resolve(source: CodeModeImageSource, signal?: AbortSignal): Promise<AttachmentContent>;
}

export function createCodeModeImagePort(options: { store: AttachmentStore; references: readonly AttachmentContent[] }): CodeModeImagePort {
  const known = new Map<string, Extract<AttachmentContent, { type: "image" }>>();
  const port: CodeModeImagePort = {
    remember(attachments) {
      for (const attachment of attachments) {
        assertAttachmentContent(attachment);
        if (attachment.type === "image") known.set(attachment.ref.id, structuredClone(attachment));
      }
    },
    async resolve(source, signal) {
      if ("data" in source) {
        if (source.data.length > Math.ceil(options.store.imageLimits.maxBytes / 3) * 4) throw new AttachmentError("LIMIT_EXCEEDED", "Image exceeds source byte limit");
        const data = Buffer.from(source.data, "base64");
        if (data.toString("base64") !== source.data) throw new AttachmentError("INVALID_REFERENCE", "Invalid image base64");
        const release = options.store.protect();
        try {
          const ref = (await options.store.saveImages([{ data, name: "codemode-image" }], signal))[0];
          if (!ref) throw new AttachmentError("INVALID_REFERENCE", "Image decoder returned no image");
          const attachment: AttachmentContent = { type: "image", ref };
          port.remember([attachment]);
          return attachment;
        } finally { release(); }
      }
      if (!("attachment_id" in source)) throw new AttachmentError("INVALID_REFERENCE", "Expected an image attachment reference");
      const found = known.get(source.attachment_id);
      if (!found) throw new AttachmentError("ACCESS_DENIED", "Image is not referenced by this session or script execution");
      const view = source.view ?? found.view ?? {};
      assertImageView(view);
      if (Object.keys(view).some(key => key !== "region" && key !== "fullResolution")) throw new AttachmentError("INVALID_REFERENCE", "Invalid image view fields");
      const release = options.store.protect();
      try {
        const limits = options.store.imageLimits;
        await options.store.prepareImage(found.ref, { ...view, maxPixels: limits.maxPixels, maxDimension: limits.maxDimension,
          maxBytes: limits.maxBytes, formats: ["image/png", "image/jpeg", "image/webp"] }, signal);
        return { type: "image", ref: found.ref, view };
      } finally { release(); }
    },
  };
  port.remember(options.references);
  return port;
}
