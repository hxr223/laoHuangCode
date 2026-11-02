export interface CodeModeWorkerLease {
  acquireWorker(): () => void;
  releaseUnused(): void;
}

export interface CodeModeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class CodeModeQueueError extends Error {
  readonly kind: "timeout" | "aborted" | "closed";
  constructor(kind: CodeModeQueueError["kind"], message: string) {
    super(message); this.name = "CodeModeQueueError"; this.kind = kind;
  }
}

export class CodeModeWorkerPool {
  private readonly maxWorkers: number;
  private readonly clock: CodeModeClock;
  private readonly waitTimeoutMs: number;
  private readonly waiting: { deadline: number; waitMs: number; resolve(lease: CodeModeWorkerLease): void; reject(error: Error): void }[] = [];
  private occupied = 0;
  private closed = false;

  constructor(options: { maxWorkers?: number; waitTimeoutMs?: number; clock?: CodeModeClock } = {}) {
    this.maxWorkers = options.maxWorkers ?? 2;
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < 1) throw new RangeError("Invalid Code Mode Worker capacity");
    this.waitTimeoutMs = options.waitTimeoutMs ?? 60000;
    if (!Number.isInteger(this.waitTimeoutMs) || this.waitTimeoutMs < 1 || this.waitTimeoutMs > 2147483647) throw new RangeError("Invalid Code Mode queue timeout");
    this.clock = options.clock ?? { now: () => performance.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) };
  }

  reserve(options: { signal?: AbortSignal; timeoutMs?: number; onQueued?: () => void } = {}): Promise<CodeModeWorkerLease> {
    if (this.closed) return Promise.reject(new CodeModeQueueError("closed", "Code Mode Worker pool is closed"));
    if (options.signal?.aborted) return Promise.reject(new CodeModeQueueError("aborted", "Code Mode queue wait cancelled"));
    const remaining = options.timeoutMs ?? Infinity;
    if (Number.isNaN(remaining)) return Promise.reject(new RangeError("Invalid remaining Code Mode deadline"));
    if (remaining <= 0) return Promise.reject(new CodeModeQueueError("timeout", "Code Mode deadline expired before acquiring a Worker; script was not started."));
    if (this.occupied < this.maxWorkers && !this.waiting.length) return Promise.resolve(this.lease());
    return new Promise((resolve, reject) => {
      const waitMs = Math.min(remaining, this.waitTimeoutMs);
      let timer: unknown;
      const cleanup = () => { this.clock.clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      const entry = { deadline: this.clock.now() + waitMs, waitMs,
        resolve: (lease: CodeModeWorkerLease) => { cleanup(); resolve(lease); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        const reason = options.signal?.reason;
        entry.reject(new CodeModeQueueError("aborted", reason instanceof Error ? reason.message : String(reason ?? "Code Mode queue wait cancelled")));
      };
      this.waiting.push(entry);
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = this.clock.setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.reject(new CodeModeQueueError("timeout", `Code Mode queue wait exceeded ${waitMs}ms; script was not started.`));
      }, waitMs);
      try { options.onQueued?.(); } catch (error) {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) { this.waiting.splice(index, 1); entry.reject(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(new CodeModeQueueError("closed", "Code Mode Worker pool is closed"));
  }

  private lease(): CodeModeWorkerLease {
    this.occupied++;
    let state: "reserved" | "started" | "released" = "reserved";
    const release = () => {
      if (state === "released") return;
      state = "released";
      this.occupied--;
      while (this.waiting.length) {
        const next = this.waiting.shift()!;
        if (next.deadline <= this.clock.now()) {
          next.reject(new CodeModeQueueError("timeout", `Code Mode queue wait exceeded ${next.waitMs}ms; script was not started.`));
          continue;
        }
        next.resolve(this.lease()); break;
      }
    };
    return {
      acquireWorker: () => {
        if (state !== "reserved") throw new Error("Code Mode Worker lease was already used");
        state = "started";
        return release;
      },
      releaseUnused: () => { if (state === "reserved") release(); },
    };
  }
}
