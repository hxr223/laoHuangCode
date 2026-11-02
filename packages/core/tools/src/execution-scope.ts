import { CancelToken } from "@laohuang/runtime-protocol";

/** Tracks physical work independently from the result returned to a caller. */
export class ExecutionScope {
  readonly token = new CancelToken();
  readonly settled: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private resolveSettled!: () => void;
  private closed = false;
  private readonly unlinkParent: () => void;

  constructor(parent: CancelToken | null) {
    this.settled = new Promise(resolve => { this.resolveSettled = resolve; });
    this.unlinkParent = parent?.register(reason => this.token.cancel(reason)) ?? (() => {});
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.finish(work), () => this.finish(work));
    return work;
  }

  close(): void {
    this.closed = true;
    this.checkSettled();
  }

  private finish(work: Promise<unknown>): void {
    this.pending.delete(work);
    this.checkSettled();
  }

  private checkSettled(): void {
    if (!this.closed || this.pending.size) return;
    this.unlinkParent();
    this.resolveSettled();
  }
}
