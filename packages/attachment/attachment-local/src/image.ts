import sharp from "sharp";
import { AttachmentError, assertImageView, type ImageInput, type ImageLimits, type ImageRef, type ImageTarget, type PreparedImage } from "@laohuang/attachment";

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;

export async function inspectImage(input: ImageInput, limits: ImageLimits): Promise<Omit<ImageRef, "id" | "name" | "bytes">> {
  if (input.data.byteLength === 0 || input.data.byteLength > limits.maxBytes) throw new AttachmentError("LIMIT_EXCEEDED", "Image source byte limit exceeded or empty image");
  try {
    const decoder = sharp(input.data, { failOn: "warning", limitInputPixels: limits.maxPixels });
    const meta = await decoder.metadata();
    if (!meta.format || !(meta.format in MIME)) throw new AttachmentError("INVALID_IMAGE", "Only PNG, JPEG, WebP and GIF are accepted");
    const mimeType = MIME[meta.format as keyof typeof MIME];
    if (input.mimeType !== undefined && input.mimeType !== mimeType) throw new AttachmentError("INVALID_IMAGE", "Image MIME does not match its bytes");
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = rotated ? meta.height : meta.width;
    const height = rotated ? meta.width : meta.height;
    if (width * height > limits.maxPixels || Math.max(width, height) > limits.maxDimension) throw new AttachmentError("LIMIT_EXCEEDED", "Image pixel or dimension limit exceeded");
    // Decode the first frame completely; animations are preserved but only their first frame is sent.
    await decoder.stats();
    return { mimeType, width, height, animated: (meta.pages ?? 1) > 1 };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("INVALID_IMAGE", "Image cannot be decoded safely", { cause: error });
  }
}

export function validateTarget(target: ImageTarget): void {
  assertImageView(target);
  if (![target.maxBytes, target.maxPixels, target.maxDimension].every(n => Number.isSafeInteger(n) && n > 0) ||
    target.formats.length === 0 || target.formats.some(f => !["image/png", "image/jpeg", "image/webp"].includes(f))) {
    throw new AttachmentError("LIMIT_EXCEEDED", "Invalid image request limits");
  }
}

export async function renderImage(data: Uint8Array, ref: ImageRef, target: ImageTarget, variantId: string, signal?: AbortSignal): Promise<PreparedImage> {
  validateTarget(target);
  const region = target.region;
  if (region && (region.x + region.width > ref.width || region.y + region.height > ref.height)) throw new AttachmentError("LIMIT_EXCEEDED", "Crop is outside the oriented original image");
  const sourceWidth = region?.width ?? ref.width;
  const sourceHeight = region?.height ?? ref.height;
  let scale = Math.min(1, Math.sqrt(target.maxPixels / (sourceWidth * sourceHeight)), target.maxDimension / Math.max(sourceWidth, sourceHeight));
  if (target.fullResolution && scale < 1) throw new AttachmentError("LIMIT_EXCEEDED", "Native resolution exceeds image pixel limits; use a crop or allow resizing");
  const base = sharp(data, { failOn: "warning", limitInputPixels: ref.width * ref.height }).rotate().toColourspace("srgb");
  if (region) base.extract({ left: region.x, top: region.y, width: region.width, height: region.height });
  const alpha = (await base.metadata()).hasAlpha;
  const formats = target.formats.filter(f => !alpha || f !== "image/jpeg");
  if (formats.length === 0) throw new AttachmentError("LIMIT_EXCEEDED", "Request formats cannot preserve image transparency");
  let previous = "";
  while (true) {
    signal?.throwIfAborted();
    const width = Math.max(1, Math.floor(sourceWidth * scale));
    const height = Math.max(1, Math.floor(sourceHeight * scale));
    if (width * height > target.maxPixels) { scale *= 0.75; continue; }
    const dimensions = `${width}x${height}`;
    if (dimensions === previous) break;
    previous = dimensions;
    for (const mimeType of formats) {
      for (const quality of mimeType === "image/png" ? [100] : [85, 75, 60]) {
        signal?.throwIfAborted();
        const pipeline = base.clone().resize(width, height, { fit: "fill", withoutEnlargement: true });
        const encoded = mimeType === "image/png" ? pipeline.png() : mimeType === "image/webp" ? pipeline.webp({ quality }) : pipeline.jpeg({ quality });
        const { data: output, info } = await encoded.toBuffer({ resolveWithObject: true });
        if (output.length <= target.maxBytes) {
          signal?.throwIfAborted();
          return {
            data: output, mimeType, width: info.width, height: info.height, variantId,
            note: `Original oriented size ${ref.width}x${ref.height}; sent ${info.width}x${info.height}.` +
              (region ? ` Crop origin (${region.x},${region.y}), source region ${region.width}x${region.height}; scale coordinates to that region then add the origin.` : " Scale coordinates to the original size.") +
              (ref.animated ? " Animation: only the first frame is shown." : ""),
          };
        }
      }
    }
    if (target.fullResolution || (width === 1 && height === 1)) break;
    scale *= 0.75;
  }
  throw new AttachmentError("LIMIT_EXCEEDED", "Image cannot fit the request byte limit without violating the requested view");
}
