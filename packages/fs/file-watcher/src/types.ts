export type WatchState = "starting" | "watching" | "recovering" | "failed" | "closed";

/** Notifications describe changes, not a lossless filesystem journal. Re-read before use. */
export type WatchChange = {
  readonly type: "change";
  readonly path: string;
  readonly action: "created" | "modified" | "deleted";
  readonly kind: "file" | "directory";
} | {
  readonly type: "invalidate";
  readonly path: string;
  readonly reason: "recovered" | "overflow";
};

export interface WatchFailure {
  readonly path: string;
  readonly error: Error;
  readonly recoverable: boolean;
  readonly source: "backend" | "listener";
}

export interface WatchOptions {
  readonly recursive?: boolean;
  /** Zero includes direct children; one also includes grandchildren. */
  readonly depth?: number;
  /** Absolute normalized paths. Must be synchronous and side-effect free. */
  readonly ignored?: (path: string) => boolean;
}

export interface WatchSubscription { dispose(): void }

export interface WatchHandle {
  /** Rejects on terminal startup failure or disposal before startup completes. */
  readonly ready: Promise<void>;
  readonly state: WatchState;
  readonly lastError: WatchFailure | undefined;
  onDidChange(listener: (change: WatchChange) => void | Promise<void>): WatchSubscription;
  onError(listener: (failure: WatchFailure) => void | Promise<void>): WatchSubscription;
  /** Stops this subscription; the final subscriber also waits for backend closure. */
  dispose(): Promise<void>;
}

export interface WatchServiceOptions {
  /** Fixed batching window, not business refresh debounce. Default 25 ms. */
  readonly coalesceMs?: number;
  readonly maxPendingChanges?: number;
  readonly startupTimeoutMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

export interface WatchService {
  watch(path: string, options?: WatchOptions): WatchHandle;
  /** Stops all tasks and waits for every backend to close, even if one fails. */
  close(): Promise<void>;
}
