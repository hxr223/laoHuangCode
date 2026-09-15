import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BackendFactory, WatchBackend } from "./chokidar-backend.ts";
import type { WatchChange, WatchFailure, WatchOptions, WatchServiceOptions, WatchState } from "./types.ts";

export interface TaskSettings extends Required<WatchServiceOptions> {}
export interface TaskObserver {
  markReady(): void;
  change(change: WatchChange): void;
  error(failure: WatchFailure): void;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function existingParent(path: string): Promise<string> {
  let candidate = dirname(path);
  for (;;) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
      throw Object.assign(new Error(`Watch ancestor is not a directory: ${candidate}`), { code: "ENOTDIR" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export class WatchTask {
  readonly path: string;
  readonly options: WatchOptions;
  readonly observers = new Set<TaskObserver>();
  state: WatchState = "starting";
  lastError: WatchFailure | undefined;
  private readonly settings: TaskSettings;
  private readonly factory: BackendFactory;
  private backend: WatchBackend | undefined;
  private generation = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<string, WatchChange>();
  private operation: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private closeErrors: unknown[] = [];

  constructor(path: string, options: WatchOptions, settings: TaskSettings, factory: BackendFactory) {
    this.path = path;
    this.options = options;
    this.settings = settings;
    this.factory = factory;
  }

  start(): void { this.open(false); }

  private open(recovery: boolean): void {
    const generation = ++this.generation;
    this.operation = this.operation.then(async () => {
      if (generation !== this.generation) return;
      try {
        // Watching an existing ancestor preserves the target's deletion/recreation events.
        // The filter prunes unrelated siblings before Chokidar traverses them.
        const anchor = await existingParent(this.path);
        if (generation !== this.generation) return;
        const backend = this.factory(
          (path) => !this.allowed(resolve(path), true),
          {
            ready: () => {
              if (generation !== this.generation) return;
              clearTimeout(this.startupTimer);
              this.state = "watching";
              this.lastError = undefined;
              for (const observer of this.observers) observer.markReady();
              if (recovery) this.queue({ type: "invalidate", path: this.path, reason: "recovered" });
            },
            change: (change) => {
              if (generation !== this.generation) return;
              try {
                const path = resolve(change.path);
                if (this.allowed(path, false)) {
                  this.failures = 0;
                  this.queue({ ...change, path });
                }
                if (change.action === "deleted" && change.kind === "directory" && inside(path, this.path)) {
                  // Chokidar can emit a transient ancestor unlink while adding
                  // a symlink (notably /var on macOS). Confirm it before recovery.
                  void stat(path).then(info => {
                    if (!info.isDirectory()) this.fail(Object.assign(new Error(`Watch directory removed: ${path}`), { code: "ENOENT" }), generation);
                  }, error => this.fail(error, generation));
                }
              } catch (error) { this.fail(error, generation); }
            },
            error: (error) => this.fail(error, generation),
          },
        );
        this.backend = backend;
        this.startupTimer = setTimeout(() => {
          this.fail(Object.assign(new Error(`Watch startup timed out: ${this.path}`), { code: "ETIMEDOUT" }), generation);
        }, this.settings.startupTimeoutMs);
        this.startupTimer.unref();
        backend.start(anchor);
      } catch (error) { this.fail(error, generation); }
    });
  }

  private allowed(path: string, includeAncestors: boolean): boolean {
    if (path !== this.path && inside(path, this.path)) return includeAncestors;
    if (!inside(this.path, path)) return false;
    const rel = relative(this.path, path);
    const depth = this.options.recursive === false ? 0 : this.options.depth;
    if (rel && depth !== undefined && rel.split(sep).length > depth + 1) return false;
    return !this.options.ignored?.(path);
  }

  private fail(value: unknown, generation: number): void {
    if (generation !== this.generation) return;
    const error = value instanceof Error ? value : new Error(String(value));
    const code = "code" in error ? error.code : undefined;
    const recoverable = typeof code === "string" && ["ENOENT", "EIO", "EBUSY", "EMFILE", "ENFILE", "ENOSPC", "ETIMEDOUT"].includes(code);
    ++this.generation;
    clearTimeout(this.startupTimer);
    this.state = recoverable ? "recovering" : "failed";
    const failure: WatchFailure = { path: this.path, error, recoverable, source: "backend" };
    this.lastError = failure;
    for (const observer of this.observers) observer.error(failure);
    this.operation = this.operation.then(async () => {
      try { await this.closeBackend(); }
      catch (closeError) {
        this.closeErrors.push(closeError);
        if (this.state !== "closed") {
          this.state = "failed";
          const failure: WatchFailure = { path: this.path, error: closeError instanceof Error ? closeError : new Error(String(closeError)), recoverable: false, source: "backend" };
          this.lastError = failure;
          for (const observer of this.observers) observer.error(failure);
        }
        return;
      }
      if (this.state !== "recovering") return;
      const delay = Math.min(this.settings.retryBaseMs * 2 ** Math.min(this.failures++, 30), this.settings.retryMaxMs);
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.open(true); }, delay);
      this.retryTimer.unref();
    });
  }

  private queue(change: WatchChange): void {
    if (this.pending.has("invalidate")) return;
    if (change.type === "invalidate" || this.pending.size >= this.settings.maxPendingChanges) {
      this.pending.clear();
      this.pending.set("invalidate", change.type === "invalidate" ? change : { type: "invalidate", path: this.path, reason: "overflow" });
    } else {
      const key = `${change.action}:${change.kind}:${change.path}`;
      this.pending.delete(key);
      this.pending.set(key, change);
    }
    if (this.batchTimer !== undefined) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      const changes = [...this.pending.values()];
      this.pending.clear();
      for (const item of changes) for (const observer of this.observers) observer.change(item);
    }, this.settings.coalesceMs);
    this.batchTimer.unref();
  }

  private async closeBackend(): Promise<void> {
    const backend = this.backend;
    this.backend = undefined;
    await backend?.close();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed";
    ++this.generation;
    clearTimeout(this.retryTimer);
    clearTimeout(this.startupTimer);
    clearTimeout(this.batchTimer);
    this.pending.clear();
    this.closing = (async () => {
      await this.operation;
      try { await this.closeBackend(); } catch (error) { this.closeErrors.push(error); }
      if (this.closeErrors.length) throw new AggregateError(this.closeErrors, "Failed to close file watcher");
    })();
    return this.closing;
  }
}
