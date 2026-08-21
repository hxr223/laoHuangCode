/** Cooperative, task-scoped cancellation primitives. */

/** Raised by {@link CancelToken.throwIfCancelled}. */
export class CancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancellationError";
  }
}

export type CancelCallback = (reason: string) => void;

/**
 * An idempotent, single-threaded cancellation token.
 *
 * Registered callbacks run synchronously in the call stack that wins the
 * first call to {@link cancel}. A callback registered after cancellation
 * runs immediately, before {@link register} returns.
 */
export class CancelToken {
  #cancelled = false;
  #reason: string | null = null;
  #requestedAt: number | null = null;
  #callbacks = new Map<number, CancelCallback>();
  #nextCallbackId = 0;
  #waiters = new Set<() => void>();
  #controller = new AbortController();

  get reason(): string | null {
    return this.#reason;
  }

  /** `performance.now()` timestamp of the first cancel, or null. */
  get requestedAt(): number | null {
    return this.#requestedAt;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** AbortSignal view of the token, for APIs that accept one. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  isCancelled(): boolean {
    return this.#cancelled;
  }

  /**
   * Request cancellation. Returns true for the first (winning) call and
   * false for every subsequent call.
   */
  cancel(reason = "cancelled"): boolean {
    const effectiveReason = reason || "cancelled";
    if (this.#cancelled) {
      return false;
    }
    this.#reason = effectiveReason;
    this.#requestedAt = performance.now();
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    this.#cancelled = true;
    this.#controller.abort(new CancellationError(effectiveReason));
    for (const callback of callbacks) {
      try {
        callback(effectiveReason);
      } catch {
        // Cancellation must remain effective even if a cleanup hook is
        // faulty; owners can report their own cleanup failures.
        continue;
      }
    }
    for (const resolve of this.#waiters) {
      resolve();
    }
    this.#waiters.clear();
    return true;
  }

  /**
   * Resolve true once the token is cancelled. With `timeoutMs`, resolve
   * false instead when the timeout elapses first.
   */
  wait(timeoutMs?: number): Promise<boolean> {
    if (this.#cancelled) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onCancel = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        this.#waiters.delete(onCancel);
        resolve(true);
      };
      this.#waiters.add(onCancel);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#waiters.delete(onCancel);
          resolve(false);
        }, timeoutMs);
      }
    });
  }

  throwIfCancelled(): void {
    if (this.#cancelled) {
      throw new CancellationError(this.#reason ?? "cancelled");
    }
  }

  /** Register a cancellation hook and return an unregister function. */
  register(callback: CancelCallback): () => void {
    if (this.#cancelled) {
      const reason = this.#reason ?? "cancelled";
      try {
        callback(reason);
      } catch {
        // Late-registered hooks must not break the registering caller.
      }
      return () => {};
    }
    this.#nextCallbackId += 1;
    const callbackId = this.#nextCallbackId;
    this.#callbacks.set(callbackId, callback);
    return () => {
      this.#callbacks.delete(callbackId);
    };
  }
}
