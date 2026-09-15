import { resolve } from "node:path";
import { createChokidarBackend, type BackendFactory } from "./chokidar-backend.ts";
import { WatchTask, type TaskObserver, type TaskSettings } from "./watch-task.ts";
import type { WatchChange, WatchFailure, WatchHandle, WatchOptions, WatchService, WatchServiceOptions, WatchSubscription } from "./types.ts";

class Handle implements WatchHandle, TaskObserver {
  readonly ready: Promise<void>;
  private readonly task: WatchTask;
  private readonly release: () => Promise<void>;
  private readonly listeners = new Set<(change: WatchChange) => void | Promise<void>>();
  private readonly errors = new Set<(failure: WatchFailure) => void | Promise<void>>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private settled = false;
  private disposed = false;
  private closing: Promise<void> | undefined;

  constructor(task: WatchTask, release: () => Promise<void>) {
    this.task = task;
    this.release = release;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Consumers may subscribe without awaiting readiness; preserve rejection for those who do.
    void this.ready.catch(() => {});
    task.observers.add(this);
    if (task.state === "watching") this.markReady();
    else if (task.state === "failed" && task.lastError) this.error(task.lastError);
  }

  get state() { return this.disposed ? "closed" as const : this.task.state; }
  get lastError() { return this.task.lastError; }

  // Keep task readiness notification separate from the public Promise.
  markReady(): void {
    if (this.settled || this.disposed) return;
    this.settled = true;
    this.resolveReady();
  }

  change(change: WatchChange): void {
    for (const listener of this.listeners) {
      if (this.disposed) break;
      try {
        void Promise.resolve(listener(change)).catch((error: unknown) => this.listenerError(error));
      } catch (error) { this.listenerError(error); }
    }
  }

  error(failure: WatchFailure): void {
    if (this.disposed) return;
    if (!failure.recoverable && failure.source === "backend" && !this.settled) {
      this.settled = true;
      this.rejectReady(failure.error);
    }
    for (const listener of this.errors) {
      if (this.disposed) break;
      // Error handlers are isolated too; recursively publishing their errors would loop.
      try { void Promise.resolve(listener(failure)).catch(() => {}); } catch { /* isolated */ }
    }
  }

  private listenerError(value: unknown): void {
    this.error({ path: this.task.path, error: value instanceof Error ? value : new Error(String(value)), recoverable: false, source: "listener" });
  }

  onDidChange(listener: (change: WatchChange) => void | Promise<void>): WatchSubscription {
    if (!this.disposed) this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  onError(listener: (failure: WatchFailure) => void | Promise<void>): WatchSubscription {
    if (!this.disposed) this.errors.add(listener);
    return { dispose: () => { this.errors.delete(listener); } };
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(new Error("File watch disposed before becoming ready"));
    }
    this.task.observers.delete(this);
    this.listeners.clear();
    this.errors.clear();
    this.closing = this.release();
    return this.closing;
  }
}

/** Internal constructor accepts a backend factory for deterministic lifecycle tests. */
export class FileWatchService implements WatchService {
  private readonly tasks = new Map<string, WatchTask>();
  private readonly handles = new Set<Handle>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private readonly filterIds = new WeakMap<NonNullable<WatchOptions["ignored"]>, number>();
  private nextFilter = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly settings: TaskSettings;
  private readonly factory: BackendFactory;

  constructor(options: WatchServiceOptions = {}, factory: BackendFactory = createChokidarBackend) {
    this.factory = factory;
    this.settings = {
      coalesceMs: options.coalesceMs ?? 25,
      maxPendingChanges: options.maxPendingChanges ?? 1024,
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      retryBaseMs: options.retryBaseMs ?? 1000,
      retryMaxMs: options.retryMaxMs ?? 30_000,
    };
    for (const [name, value] of Object.entries(this.settings)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (name === "coalesceMs" ? 0 : 1) || value > 2_147_483_647) {
        throw new RangeError(`Invalid watcher setting: ${name}`);
      }
    }
    if (this.settings.retryMaxMs < this.settings.retryBaseMs) throw new RangeError("retryMaxMs must be at least retryBaseMs");
  }

  watch(path: string, options: WatchOptions = {}): WatchHandle {
    if (this.closed) throw new Error("File watch service is closed");
    if (!path || path.includes("\0")) throw new TypeError("Watch path must be nonempty and contain no NUL");
    if (options.depth !== undefined && (!Number.isSafeInteger(options.depth) || options.depth < 0)) throw new RangeError("Watch depth must be a nonnegative integer");
    if (options.recursive === false && options.depth !== undefined && options.depth !== 0) throw new RangeError("Nonrecursive watches must have depth zero");
    const target = resolve(path);
    let filterId = 0;
    if (options.ignored) {
      const existing = this.filterIds.get(options.ignored);
      filterId = existing ?? ++this.nextFilter;
      if (existing === undefined) this.filterIds.set(options.ignored, filterId);
    }
    const normalized = { recursive: options.recursive ?? true, depth: options.recursive === false ? 0 : options.depth, ignored: options.ignored };
    const key = JSON.stringify([target, normalized.depth ?? null, filterId]);
    let task = this.tasks.get(key);
    const fresh = task === undefined;
    if (!task) {
      task = new WatchTask(target, normalized, this.settings, this.factory);
      this.tasks.set(key, task);
    }
    const selected = task;
    const handle = new Handle(selected, () => {
      this.handles.delete(handle);
      if (selected.observers.size) return Promise.resolve();
      if (this.tasks.get(key) === selected) this.tasks.delete(key);
      const closing = selected.close();
      this.pendingCloses.add(closing);
      // Retain failed closes so service.close also reports them.
      void closing.then(() => { this.pendingCloses.delete(closing); }, () => {});
      return closing;
    });
    this.handles.add(handle);
    if (fresh) selected.start();
    return handle;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([
        ...[...this.handles].map((handle) => handle.dispose()),
        ...this.pendingCloses,
      ]);
      const errors = [...new Set(results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []))];
      if (errors.length) throw new AggregateError(errors, "Failed to close file watch service");
    })();
    return this.closing;
  }
}

export function createWatchService(options: WatchServiceOptions = {}): WatchService {
  return new FileWatchService(options);
}
