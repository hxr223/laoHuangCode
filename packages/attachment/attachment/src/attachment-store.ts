import type { AttachmentId, CollectionResult, FileRef, ImageInput, ImageLimits, ImageRef, ImageTarget, PreparedImage } from "./types.ts";

/** Storage is shared; session authorization belongs to the caller before resolving a reference. */
export abstract class AttachmentStore {
  abstract readonly imageLimits: ImageLimits;
  abstract saveFile(source: AsyncIterable<Uint8Array>, name: string, signal?: AbortSignal): Promise<FileRef>;
  /** Streaming integrity failures reject at EOF; callers must finish iteration before treating it as verified. */
  abstract readFile(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  abstract saveImages(inputs: readonly ImageInput[], signal?: AbortSignal): Promise<readonly ImageRef[]>;
  abstract prepareImage(ref: ImageRef, target: ImageTarget, signal?: AbortSignal): Promise<PreparedImage>;
  /** Protects an in-flight operation across processes. Always release, including cancellation. */
  abstract protect(): () => void;
  /** Synchronous durable-message commit and final existence check share the collector's transaction. */
  abstract commit<T>(refs: readonly FileRef[], write: () => T): T;
  /** Callback must provide a complete persistent reference snapshot; throw when uncertain. */
  abstract collectGarbage(references: () => ReadonlySet<AttachmentId>, force?: boolean): CollectionResult;
  abstract close(): void;
}
