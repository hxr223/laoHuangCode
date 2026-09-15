import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWatchService, type WatchChange, type WatchFailure } from "../packages/fs/file-watcher/src/index.ts";
import { FileWatchService } from "../packages/fs/file-watcher/src/watch-service.ts";
import type { BackendCallbacks, BackendFactory } from "../packages/fs/file-watcher/src/chokidar-backend.ts";

async function until(predicate: () => boolean, message = "condition", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${message}`);
    await delay(10);
  }
}

async function fixture(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laohuang-watch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeBackend() {
  const entries: Array<{ callbacks: BackendCallbacks; closed: boolean; path: string; ignored: (path: string) => boolean }> = [];
  let closeHook: (() => Promise<void>) | undefined;
  const factory: BackendFactory = (ignored, callbacks) => {
    const entry = { callbacks, closed: false, path: "", ignored };
    entries.push(entry);
    return {
      start: (path) => { entry.path = path; },
      close: async () => { await closeHook?.(); entry.closed = true; },
    };
  };
  return { entries, factory, setCloseHook: (hook: () => Promise<void>) => { closeHook = hook; } };
}

test("watcher shares compatible subscriptions and isolates disposal and listener errors", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({ coalesceMs: 1 }, fake.factory);
  t.after(() => service.close());
  const a = service.watch(root);
  const b = service.watch(join(root, "."));
  const events: WatchChange[] = [];
  const errors: WatchFailure[] = [];
  a.onError((failure) => { errors.push(failure); });
  a.onDidChange(() => { throw new Error("consumer failed"); });
  b.onDidChange((change) => { events.push(change); });
  await until(() => fake.entries.length === 1);
  const backend = fake.entries[0]!;
  backend.callbacks.ready();
  await Promise.all([a.ready, b.ready]);
  backend.callbacks.change({ type: "change", path: join(root, "a"), action: "created", kind: "file" });
  await until(() => events.length === 1 && errors.length === 1);
  assert.equal(errors[0]!.source, "listener");
  await a.dispose();
  assert.equal(backend.closed, false);
  backend.callbacks.change({ type: "change", path: join(root, "b"), action: "modified", kind: "file" });
  await until(() => events.length === 2);
  const c = service.watch(root);
  await c.ready;
  await b.dispose();
  assert.equal(backend.closed, false);
  await c.dispose();
  assert.equal(backend.closed, true);
  backend.callbacks.change({ type: "change", path: join(root, "late"), action: "created", kind: "file" });
  await delay(20);
  assert.equal(events.length, 2);
});

test("watcher filter identity and depth determine sharing; callbacks can be removed separately", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({ coalesceMs: 1 }, fake.factory);
  t.after(() => service.close());
  const filter = (path: string) => path.endsWith(".ignore");
  const a = service.watch(root, { ignored: filter, recursive: false });
  const b = service.watch(root, { ignored: filter, depth: 0 });
  const c = service.watch(root, { ignored: filter });
  const d = service.watch(root, { ignored: () => false });
  await until(() => fake.entries.length === 3);
  for (const item of fake.entries) item.callbacks.ready();
  await Promise.all([a.ready, b.ready, c.ready, d.ready]);
  let count = 0;
  const subscription = a.onDidChange(() => { count++; });
  const entry = fake.entries[0]!;
  assert.equal(entry.ignored(join(root, "a.ignore")), true);
  assert.equal(entry.ignored(join(root, "dir", "nested")), true);
  assert.equal(entry.ignored(join(root, "direct")), false);
  subscription.dispose();
  entry.callbacks.change({ type: "change", path: join(root, "direct"), action: "created", kind: "file" });
  await delay(20);
  assert.equal(count, 0);
  assert.equal(a.state, "watching");
});

test("watcher coalesces repeats and invalidates instead of growing an unbounded queue", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({ coalesceMs: 1, maxPendingChanges: 2 }, fake.factory);
  t.after(() => service.close());
  const handle = service.watch(root);
  const events: WatchChange[] = [];
  handle.onDidChange((change) => { events.push(change); });
  await until(() => fake.entries.length === 1);
  const callbacks = fake.entries[0]!.callbacks;
  callbacks.ready();
  for (let i = 0; i < 5; i++) callbacks.change({ type: "change", path: join(root, "same"), action: "modified", kind: "file" });
  await until(() => events.length === 1);
  assert.equal(events[0]!.type, "change");
  for (let i = 0; i < 5; i++) callbacks.change({ type: "change", path: join(root, String(i)), action: "created", kind: "file" });
  await until(() => events.length === 2);
  assert.deepEqual(events[1], { type: "invalidate", path: root, reason: "overflow" });
});

test("watcher retries startup and runtime errors and invalidates after recovery", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({ retryBaseMs: 10, retryMaxMs: 20, coalesceMs: 1 }, fake.factory);
  t.after(() => service.close());
  const handle = service.watch(root);
  const events: WatchChange[] = [];
  const errors: WatchFailure[] = [];
  handle.onDidChange((change) => { events.push(change); });
  handle.onError((failure) => { errors.push(failure); });
  await until(() => fake.entries.length === 1);
  fake.entries[0]!.callbacks.error(Object.assign(new Error("temporary"), { code: "EMFILE" }));
  assert.equal(handle.state, "recovering");
  await until(() => fake.entries.length === 2);
  assert.equal(fake.entries[0]!.closed, true);
  fake.entries[0]!.callbacks.ready(); // Old generation must not settle the handle.
  assert.equal(handle.state, "recovering");
  fake.entries[1]!.callbacks.ready();
  await handle.ready;
  await until(() => events.length === 1);
  assert.equal(events[0]!.type, "invalidate");
  fake.entries[1]!.callbacks.error(Object.assign(new Error("I/O"), { code: "EIO" }));
  await until(() => fake.entries.length === 3);
  fake.entries[2]!.callbacks.ready();
  await until(() => events.length === 2);
  assert.equal(errors.length, 2);
  assert.equal(handle.lastError, undefined);
});

test("terminal startup failures reject ready and runtime failures remain observable", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({}, fake.factory);
  t.after(() => service.close());
  const handle = service.watch(root);
  await until(() => fake.entries.length === 1);
  const error = Object.assign(new Error("denied"), { code: "EACCES" });
  fake.entries[0]!.callbacks.error(error);
  await assert.rejects(handle.ready, /denied/);
  assert.equal(handle.state, "failed");
  assert.equal(handle.lastError?.recoverable, false);
  const late = service.watch(root);
  await assert.rejects(late.ready, /denied/);
  await handle.dispose();
  await late.dispose();
  const next = service.watch(root);
  await until(() => fake.entries.length === 2);
  fake.entries[1]!.callbacks.ready();
  await next.ready;
  fake.entries[1]!.callbacks.error(error);
  assert.equal(next.state, "failed");
  assert.equal(next.lastError?.error, error);
});

test("close cancels startup and retry timers and waits for backend closure", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({ retryBaseMs: 20, retryMaxMs: 20 }, fake.factory);
  const handle = service.watch(root);
  await until(() => fake.entries.length === 1);
  let finish!: () => void;
  fake.setCloseHook(() => new Promise<void>((resolve) => { finish = resolve; }));
  fake.entries[0]!.callbacks.error(Object.assign(new Error("retry"), { code: "EIO" }));
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await assert.rejects(handle.ready, /disposed/);
  await until(() => finish !== undefined);
  assert.equal(closed, false);
  finish();
  await closing;
  await delay(50);
  assert.equal(fake.entries.length, 1);
  assert.throws(() => service.watch(root), /closed/);
  await service.close();
});

test("startup timeout recovers and immediate disposal opens no backend", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({ startupTimeoutMs: 25, retryBaseMs: 5, retryMaxMs: 5 }, fake.factory);
  t.after(() => service.close());
  const discarded = service.watch(root);
  await discarded.dispose();
  await assert.rejects(discarded.ready, /disposed/);
  assert.equal(fake.entries.length, 0);
  const handle = service.watch(root);
  await until(() => fake.entries.length === 2);
  fake.entries[1]!.callbacks.ready();
  await handle.ready;
  assert.equal(fake.entries[0]!.closed, true);
});

test("service attempts all closes even when one backend fails", async (t) => {
  const root = await fixture(t);
  const fake = fakeBackend();
  const service = new FileWatchService({}, fake.factory);
  service.watch(join(root, "a"));
  service.watch(join(root, "b"));
  await until(() => fake.entries.length === 2);
  let attempts = 0;
  fake.setCloseHook(async () => { attempts++; if (attempts === 1) throw new Error("close failed"); });
  await assert.rejects(service.close(), AggregateError);
  assert.equal(attempts, 2);
});

test("real filesystem: atomic replacement, removal and recreation of a watched file", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  const file = join(root, "config.txt");
  await writeFile(file, "before");
  const service = createWatchService({ coalesceMs: 5, retryBaseMs: 10, retryMaxMs: 50 });
  t.after(() => service.close());
  const handle = service.watch(file);
  const events: WatchChange[] = [];
  handle.onDidChange((change) => { events.push(change); });
  await handle.ready;
  const temp = join(root, "replacement");
  await writeFile(temp, "after");
  await rename(temp, file);
  await until(() => events.some((e) => e.type === "change" && e.path === file && e.action !== "deleted"), "atomic save");
  events.length = 0;
  await rm(file);
  await until(() => events.some((e) => e.type === "change" && e.action === "deleted"), "file removal");
  events.length = 0;
  await writeFile(file, "recreated");
  await until(() => events.some((e) => e.type === "change" && e.action === "created"), "file recreation");
  assert.ok(events.every((e) => e.path === file));
});

test("real filesystem: missing nested target and deleted ancestors recover", { timeout: 15000 }, async (t) => {
  const root = await fixture(t);
  const target = join(root, "new", "nested");
  const service = createWatchService({ coalesceMs: 5, retryBaseMs: 10, retryMaxMs: 50 });
  t.after(() => service.close());
  const handle = service.watch(target);
  const events: WatchChange[] = [];
  handle.onDidChange((change) => { events.push(change); });
  await handle.ready;
  await mkdir(target, { recursive: true });
  await until(() => events.some((e) => e.path === target && e.type === "change" && e.action === "created"), "missing target creation");
  await writeFile(join(target, "first"), "one");
  await until(() => events.some((e) => e.path.endsWith("first")), "nested file creation");
  events.length = 0;
  await rm(join(root, "new"), { recursive: true });
  await until(() => events.some((e) => e.type === "invalidate" && e.reason === "recovered"), "ancestor watch recovery");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "second"), "two");
  await until(() => events.some((e) => e.path.endsWith("second") || e.path === target && e.type === "change" && e.action === "created"), "recreated subtree");
  events.length = 0;
  await writeFile(join(target, "second"), "updated");
  await until(() => events.some((e) => e.path.endsWith("second") && e.type === "change" && e.action === "modified"), "watching after recreation");
});

test("real filesystem: depth, ignored subtrees and unrelated siblings stay filtered", { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  const target = join(root, "target");
  await mkdir(join(target, "nested"), { recursive: true });
  await mkdir(join(target, "ignored"));
  const service = createWatchService({ coalesceMs: 5 });
  t.after(() => service.close());
  const handle = service.watch(target, { depth: 0, ignored: (path) => path.includes("ignored") });
  const events: WatchChange[] = [];
  handle.onDidChange((change) => { events.push(change); });
  await handle.ready;
  await writeFile(join(target, "nested", "hidden"), "x");
  await writeFile(join(target, "ignored", "hidden"), "x");
  await writeFile(join(root, "sibling"), "x");
  await writeFile(join(target, "visible"), "x");
  await until(() => events.some((e) => e.path.endsWith("visible")), "direct child");
  await delay(150);
  assert.ok(events.every((e) => !e.path.endsWith("hidden") && !e.path.endsWith("sibling") && !e.path.includes("ignored")));
});

test("invalid watcher settings and paths fail before opening resources", () => {
  assert.throws(() => createWatchService({ coalesceMs: -1 }), RangeError);
  assert.throws(() => createWatchService({ retryBaseMs: 50, retryMaxMs: 10 }), RangeError);
  const service = createWatchService();
  assert.throws(() => service.watch(""), TypeError);
  assert.throws(() => service.watch("a\0b"), TypeError);
  assert.throws(() => service.watch(".", { depth: -1 }), RangeError);
  assert.throws(() => service.watch(".", { recursive: false, depth: 1 }), RangeError);
});
