import assert from "node:assert/strict";
import test from "node:test";
import { CODEMODE_LIMITS, CodeModeSandbox, loadQuickJSWasm } from "@laohuang/codemode";

test("an expired loading deadline cannot start a Worker before the timer callback runs", async () => {
  const loaded = await loadQuickJSWasm();
  let acquired = 0;
  const wasm = Promise.resolve().then(() => {
    const until = performance.now() + 20;
    while (performance.now() < until) { /* Simulate synchronous initialization work. */ }
    return loaded;
  });
  const sandbox = new CodeModeSandbox({ wasm, acquireWorker: () => { acquired++; return () => {}; } });
  try {
    const result = await sandbox.execute("return 1", { timeoutMs: 1 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "timeout");
    assert.equal(acquired, 0);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("executes JavaScript with await and round-trips a host tool result", async () => {
  const sandbox = new CodeModeSandbox({ tools: [{ name: "double", execute: args => Number(args) * 2 }] });
  try {
    const result = await sandbox.execute("return await tools.double(21)");
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.equal(result.value, 42);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("a synchronous infinite script times out without blocking the host", async () => {
  let scriptStarted = false;
  const sandbox = new CodeModeSandbox({ tools: [{ name: "ready", execute: () => { scriptStarted = true; } }] });
  const safety = new AbortController();
  const timer = setTimeout(() => safety.abort("test safety stop"), 1500);
  try {
    const result = await sandbox.execute("await tools.ready(); while (true) {}", { timeoutMs: 200, signal: safety.signal });
    assert.equal(scriptStarted, true);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "timeout");
  } finally { clearTimeout(timer); await sandbox.close(); await sandbox.drain(); }
});

test("injected namespace functions pass spread arguments through the same async bridge", async () => {
  const sandbox = new CodeModeSandbox({ globals: [{ name: "helper.join", spread: true, execute: args => args }] });
  try {
    const result = await sandbox.execute("return await helper.join('a', 2)");
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.deepEqual(result.value, ["a", 2]);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("invalid injected capabilities are rejected before creating a worker", () => {
  const execute = () => undefined;
  assert.throws(() => new CodeModeSandbox({ tools: [{ name: "read", execute }, { name: "read", execute }] }), /duplicate/i);
  for (const name of ["text", "tools.member", "a.b.c", "invalid-name", "class"]) {
    assert.throws(() => new CodeModeSandbox({ globals: [{ name, execute }] }), /global/i);
  }
  assert.throws(() => new CodeModeSandbox({ globals: [{ name: "helper", execute }, { name: "helper.member", execute }] }), /global/i);
});

test("known Node watch reports do not interrupt a valid worker result", async () => {
  const sandbox = new CodeModeSandbox({ workerUrl: new URL("./fixtures/codemode-worker-fixture.ts", import.meta.url) });
  try {
    const result = await sandbox.execute(JSON.stringify([
      { "watch:import": ["file:///fixture.js"] },
      { type: "done", ok: true, value: "42", writes: "[]" },
    ]));
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.equal(result.value, 42);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("concurrent replies keep their IDs and a caught host failure does not stop the script", async () => {
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  const sandbox = new CodeModeSandbox({ tools: [
    { name: "first", execute: async () => { first.resolve(); await second.promise; return 1; } },
    { name: "second", execute: () => { second.resolve(); return 2; } },
    { name: "fail", execute: () => { throw new Error("host failure"); } },
  ] });
  try {
    const result = await sandbox.execute(`
      const values = await Promise.all([tools.first(), tools.second()]);
      try { await tools.fail(); } catch (error) { return [values, error.message]; }
    `);
    await first.promise;
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, [[1, 2], "host failure"]);
    assert.deepEqual(result.calls.map(call => call.status), ["completed", "completed", "failed"]);
  } finally { second.resolve(); await sandbox.close(); await sandbox.drain(); }
});

test("cancel during WASM loading returns without acquiring or starting a late worker", async () => {
  const wasm = Promise.withResolvers<object>();
  const controller = new AbortController();
  let acquired = 0;
  const sandbox = new CodeModeSandbox({ wasm: wasm.promise, acquireWorker: () => { acquired++; return () => {}; } });
  try {
    const running = sandbox.execute("return 1", { signal: controller.signal });
    controller.abort("cancel loading");
    const result = await running;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "aborted");
    wasm.resolve(await loadQuickJSWasm());
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(acquired, 0);
  } finally { wasm.resolve(await loadQuickJSWasm()); await sandbox.close(); await sandbox.drain(); }
});

test("worker capacity is released once on actual exit, after the logical result", async () => {
  let releases = 0;
  const sandbox = new CodeModeSandbox({ acquireWorker: () => () => { releases++; } });
  try {
    const result = await sandbox.execute("return 42");
    assert.equal(result.ok, true);
    assert.equal(releases, 0);
    await sandbox.drain();
    assert.equal(releases, 1);
    await sandbox.close();
    await sandbox.drain();
    assert.equal(releases, 1);
    await assert.rejects(sandbox.execute("return 1"), /closed/);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("microtask loops time out and unresumable promises fail instead of hanging", async () => {
  const sandbox = new CodeModeSandbox();
  const safety = AbortSignal.timeout(1500);
  try {
    const loop = await sandbox.execute("while (true) await null;", { timeoutMs: 100, signal: safety });
    assert.equal(loop.ok, false);
    if (!loop.ok) assert.equal(loop.error.kind, "timeout");
    const stalled = await sandbox.execute("await new Promise(() => {});", { signal: safety });
    assert.equal(stalled.ok, false);
    if (!stalled.ok) assert.match(stalled.error.message, /stalled/);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("malformed worker messages fail without being mistaken for Node watch traffic", async () => {
  for (const message of [{ "watch:import": "invalid" }, { type: "call", id: "1", name: "read" },
    { type: "done", ok: true, value: "not JSON", writes: "[]" },
    { type: "output", item: { type: "text", text: 1 } }]) {
    const sandbox = new CodeModeSandbox({ workerUrl: new URL("./fixtures/codemode-worker-fixture.ts", import.meta.url) });
    try {
      const result = await sandbox.execute(JSON.stringify([message]));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "sandbox");
    } finally { await sandbox.close(); await sandbox.drain(); }
  }
});

test("worker-reported store writes cannot bypass host capacity checks", async () => {
  const sandbox = new CodeModeSandbox({ workerUrl: new URL("./fixtures/codemode-worker-fixture.ts", import.meta.url) });
  try {
    const result = await sandbox.execute(JSON.stringify([{ type: "done", ok: true,
      writes: JSON.stringify([["x", JSON.stringify("x".repeat(CODEMODE_LIMITS.storeValueChars))]]) }]));
    assert.equal(result.ok, false);
    assert.equal("storeWrites" in result, false);
  } finally { await sandbox.close(); await sandbox.drain(); }
});
