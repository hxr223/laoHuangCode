import test from "node:test";
import assert from "node:assert/strict";

// NOTE: Node 22 type stripping cannot resolve ".js" specifiers to ".ts"
// sources, so test files import the ".ts" path directly (tsc only covers src/).
import {
  CancellationError,
  CancelToken,
} from "../packages/core/runtime-protocol/src/index.ts";

test("cancel is idempotent and notifies once", () => {
  const token = new CancelToken();
  const reasons: string[] = [];
  token.register((reason) => {
    reasons.push(reason);
  });

  assert.equal(token.cancel("stop now"), true);
  assert.equal(token.cancel("second reason"), false);
  assert.equal(token.isCancelled(), true);
  assert.equal(token.cancelled, true);
  assert.equal(token.reason, "stop now");
  assert.deepEqual(reasons, ["stop now"]);
  assert.throws(() => token.throwIfCancelled(), {
    name: "CancellationError",
    message: "stop now",
  });
  assert.throws(() => token.throwIfCancelled(), CancellationError);
});

test("late registration runs immediately and unregister works", () => {
  const token = new CancelToken();
  const removed: string[] = [];
  const unregister = token.register((reason) => {
    removed.push(reason);
  });
  unregister();
  token.cancel("done");
  assert.deepEqual(removed, []);

  const late: string[] = [];
  token.register((reason) => {
    late.push(reason);
  });
  assert.deepEqual(late, ["done"]);
});

test("empty cancel reason falls back to the default", () => {
  const token = new CancelToken();
  token.cancel("");
  assert.equal(token.reason, "cancelled");
  assert.equal(typeof token.requestedAt, "number");
});

test("a faulty cleanup hook does not break cancellation", () => {
  const token = new CancelToken();
  const seen: string[] = [];
  token.register(() => {
    throw new Error("broken hook");
  });
  token.register((reason) => {
    seen.push(reason);
  });

  assert.equal(token.cancel("halt"), true);
  assert.equal(token.cancelled, true);
  assert.deepEqual(seen, ["halt"]);
});

test("wait resolves true on cancellation and false on timeout", async () => {
  const pending = new CancelToken();
  assert.equal(await pending.wait(10), false);

  const token = new CancelToken();
  const waiter = token.wait();
  token.cancel("stop");
  assert.equal(await waiter, true);

  // Already-cancelled tokens resolve immediately.
  assert.equal(await token.wait(), true);
  assert.equal(await token.wait(10), true);
});

test("abort signal fires when the token is cancelled", () => {
  const token = new CancelToken();
  assert.equal(token.signal.aborted, false);
  token.cancel("abort");
  assert.equal(token.signal.aborted, true);
  assert.equal((token.signal.reason as Error).name, "CancellationError");
});
