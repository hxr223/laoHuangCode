import { AttachmentError } from "./errors.ts";

export type AttachmentId = `sha256:${string}`;
export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export interface FileRef {
  readonly id: AttachmentId;
  readonly bytes: number;
  readonly name: string;
}
export interface ImageRef extends FileRef {
  readonly mimeType: ImageMime;
  /** Pixel dimensions after applying the source orientation. */
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}
export interface ImageRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ImageView { readonly region?: ImageRegion; readonly fullResolution?: boolean }
export type AttachmentContent =
  | { readonly type: "image"; readonly ref: ImageRef; readonly view?: ImageView }
  | { readonly type: "file"; readonly ref: FileRef };
export interface ImageTarget extends ImageView {
  readonly maxPixels: number;
  readonly maxDimension: number;
  readonly maxBytes: number;
  readonly formats: readonly Exclude<ImageMime, "image/gif">[];
}
export interface PreparedImage {
  readonly data: Uint8Array;
  readonly mimeType: Exclude<ImageMime, "image/gif">;
  readonly width: number;
  readonly height: number;
  readonly note: string;
  readonly variantId: string;
}
export interface ImageInput { readonly data: Uint8Array; readonly name: string; readonly mimeType?: ImageMime }
export interface ImageLimits {
  readonly maxBytes: number;
  readonly maxImages: number;
  readonly maxBatchBytes: number;
  readonly maxPixels: number;
  readonly maxDimension: number;
}
export const DEFAULT_IMAGE_LIMITS: ImageLimits = Object.freeze({
  maxBytes: 20 * 1024 ** 2, maxImages: 20, maxBatchBytes: 200 * 1024 ** 2,
  maxPixels: 64_000_000, maxDimension: 8192,
});
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export interface CollectionResult { readonly deleted: readonly AttachmentId[]; readonly skipped: boolean }

/** Validates references at wire/durable-data boundaries without touching storage. */
export function assertAttachmentContent(value: unknown): asserts value is AttachmentContent {
  if (!value || typeof value !== "object") throw new AttachmentError("INVALID_REFERENCE", "Invalid attachment content");
  const block = value as Record<string, unknown>;
  if (block.type !== "image" && block.type !== "file") throw new AttachmentError("INVALID_REFERENCE", "Invalid attachment kind");
  assertFileRef(block.ref);
  if (block.type === "image") {
    const ref = block.ref as unknown as Record<string, unknown>;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(ref.mimeType)) ||
      !Number.isSafeInteger(ref.width) || Number(ref.width) < 1 || !Number.isSafeInteger(ref.height) || Number(ref.height) < 1 || typeof ref.animated !== "boolean") {
      throw new AttachmentError("INVALID_REFERENCE", "Invalid image reference");
    }
    if (block.view !== undefined) assertImageView(block.view);
  }
}
export function assertFileRef(value: unknown): asserts value is FileRef {
  const ref = value as Partial<FileRef> | null;
  if (!ref || typeof ref !== "object" || typeof ref.id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.id) ||
    !Number.isSafeInteger(ref.bytes) || Number(ref.bytes) < 0 || typeof ref.name !== "string") {
    throw new AttachmentError("INVALID_REFERENCE", "Invalid attachment reference");
  }
}
export function assertImageView(value: unknown): asserts value is ImageView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttachmentError("INVALID_REFERENCE", "Invalid image view");
  const view = value as Record<string, unknown>;
  if (view.fullResolution !== undefined && typeof view.fullResolution !== "boolean") throw new AttachmentError("INVALID_REFERENCE", "Invalid fullResolution");
  if (view.region !== undefined) {
    const r = view.region as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || !["x", "y", "width", "height"].every(k => Number.isSafeInteger(r[k])) ||
      Number(r.x) < 0 || Number(r.y) < 0 || Number(r.width) < 1 || Number(r.height) < 1) {
      throw new AttachmentError("INVALID_REFERENCE", "Invalid crop region");
    }
  }
}
