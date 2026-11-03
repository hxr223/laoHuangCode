import assert from "node:assert/strict";
import test from "node:test";
import { CodeModeWorkerPool } from "@laohuang/tool-codemode";

test("only callers that actually queue receive a waiting notification", async () => {
  const pool = new CodeModeWorkerPool({ maxWorkers: 1 });
  let notices = 0;
  const first = await pool.reserve({ onQueued: () => { notices++; } });
  try {
    const waiting = pool.reserve({ onQueued: () => { notices++; } });
    assert.equal(notices, 1);
    first.releaseUnused();
    (await waiting).releaseUnused();
  } finally { first.releaseUnused(); pool.close(); }
});

test("shared worker capacity stays occupied until exit and waiting callers receive slots in FIFO order", async () => {
  const pool = new CodeModeWorkerPool();
  try {
    const first = await pool.reserve();
    const second = await pool.reserve();
    const releaseFirstOnExit = first.acquireWorker();
    const releaseSecondOnExit = second.acquireWorker();
    const order: string[] = [];
    const third = pool.reserve().then(lease => { order.push("third"); return lease; });
    const fourth = pool.reserve().then(lease => { order.push("fourth"); return lease; });
    first.releaseUnused();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(order, []);
    releaseFirstOnExit();
    const thirdLease = await third;
    assert.deepEqual(order, ["third"]);
    releaseFirstOnExit();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(order, ["third"]);
    releaseSecondOnExit();
    const fourthLease = await fourth;
    assert.deepEqual(order, ["third", "fourth"]);
    thirdLease.releaseUnused(); fourthLease.releaseUnused();
  } finally { pool.close(); }
});

test("queued scripts fail at 60000ms without acquiring a worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const pool = new CodeModeWorkerPool({ maxWorkers: 1, clock: { now: () => now,
    setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) } });
  const first = await pool.reserve();
  try {
    let failed = false;
    const waiting = pool.reserve().catch(error => { failed = true; throw error; });
    const rejected = assert.rejects(waiting, /queue.*60000ms/i);
    now = 59999; t.mock.timers.tick(59999);
    await Promise.resolve();
    assert.equal(failed, false);
    now = 60000; t.mock.timers.tick(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(failed, true);
    await rejected;
  } finally { first.releaseUnused(); pool.close(); }
});

test("a waiting caller can cancel immediately without cancelling another lease", async () => {
  const pool = new CodeModeWorkerPool({ maxWorkers: 1 });
  const first = await pool.reserve();
  const controller = new AbortController();
  try {
    const waiting = pool.reserve({ signal: controller.signal }).then(() => "started", () => "cancelled");
    controller.abort("cancel queued script");
    const result = await Promise.race([waiting, new Promise<string>(resolve => setImmediate(() => resolve("pending")))]);
    assert.equal(result, "cancelled");
    const releaseOnExit = first.acquireWorker();
    releaseOnExit();
    const next = await pool.reserve();
    next.releaseUnused();
  } finally { first.releaseUnused(); pool.close(); }
});

test("the remaining script deadline can expire before the 60 second queue limit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const pool = new CodeModeWorkerPool({ maxWorkers: 1, clock: { now: () => now,
    setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout) } });
  const first = await pool.reserve();
  try {
    const waiting = pool.reserve({ timeoutMs: 10 }).then(() => "started", error => error.kind);
    now = 10; t.mock.timers.tick(10);
    const result = await Promise.race([waiting, new Promise<string>(resolve => setImmediate(() => resolve("pending")))]);
    assert.equal(result, "timeout");
  } finally { first.releaseUnused(); pool.close(); }
});
