import assert from "node:assert/strict";
import test from "node:test";
import { CODEMODE_LIMITS, CodeModeSandbox } from "@laohuang/codemode";

test("keeps explicit output produced before a script throws", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const result = await sandbox.execute('text("before"); throw new Error("failed later")');
    assert.equal(result.ok, false);
    assert.deepEqual(result.output, [{ type: "text", text: "before" }]);
    if (!result.ok) assert.equal(result.error.message, "failed later");
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("built-in prototype changes cannot redirect the host tool bridge", async () => {
  const sandbox = new CodeModeSandbox({ tools: [{ name: "double", execute: value => Number(value) * 2 }] });
  try {
    const result = await sandbox.execute(`
      try { Map.prototype.set = () => { throw new Error('bridge poisoned'); }; } catch {}
      return await tools.double(21);
    `);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.equal(result.value, 42);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("lockdown still allows normal Error subclasses and instance overrides", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const result = await sandbox.execute(`
      class MyError extends Error { constructor() { super('message'); this.name = 'MyError'; } }
      const instance = {}; instance.toString = () => 'instance';
      return [new MyError().name, String(instance)];
    `);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.deepEqual(result.value, ["MyError", "instance"]);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("load returns a copy and successful scripts report state writes and deletions", async () => {
  const sandbox = new CodeModeSandbox();
  const store = { old: { count: 1 } };
  try {
    const result = await sandbox.execute(`
      const copy = load('old'); copy.count = 9;
      store('counter', 2); store('old', undefined); return copy;
    `, { store });
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) {
      assert.deepEqual(result.value, { count: 9 });
      assert.deepEqual(result.storeWrites, { set: { counter: 2 }, delete: ["old"] });
    }
    assert.deepEqual(store, { old: { count: 1 } });
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("catching an output limit error cannot resume a script or issue host calls", async () => {
  let called = false;
  const sandbox = new CodeModeSandbox({ tools: [{ name: "sideEffect", execute: () => { called = true; } }] });
  try {
    const result = await sandbox.execute(`
      try { text('x'.repeat(${CODEMODE_LIMITS.outputChars + 1})); } catch {}
      try { await tools.sideEffect(); } catch {}
      return 'continued';
    `);
    assert.equal(result.ok, false);
    assert.deepEqual(result.output, []);
    assert.equal(called, false);
    if (!result.ok) assert.match(result.error.message, /output.*limit/i);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("return values obey the output budget while remaining separate from explicit output", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const atLimit = await sandbox.execute(`return 'x'.repeat(${CODEMODE_LIMITS.outputChars});`);
    assert.equal(atLimit.ok, true);
    assert.deepEqual(atLimit.output, []);
    const overLimit = await sandbox.execute(`text('a'); return 'x'.repeat(${CODEMODE_LIMITS.outputChars});`);
    assert.equal(overLimit.ok, false);
    assert.deepEqual(overLimit.output, [{ type: "text", text: "a" }]);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("store accepts its exact JSON capacity and rejects the next character", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const exact = "x".repeat(CODEMODE_LIMITS.storeValueChars - 2);
    const atLimit = await sandbox.execute("store('x', load('x'));", { store: { x: exact } });
    assert.equal(atLimit.ok, true);
    const overWrite = await sandbox.execute(`store('x', 'x'.repeat(${CODEMODE_LIMITS.storeValueChars - 1}));`);
    assert.equal(overWrite.ok, false);
    assert.equal("storeWrites" in overWrite, false);
    const overInitial = await sandbox.execute("return 1", { store: { x: exact + "x" } });
    assert.equal(overInitial.ok, false);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("total store capacity includes keys and rejected writes leave the old state intact", async () => {
  const sandbox = new CodeModeSandbox();
  const value = "x".repeat(CODEMODE_LIMITS.storeValueChars - 2);
  const store = { a: value, b: value, c: value, d: value.slice(4) };
  try {
    const result = await sandbox.execute(`
      try { store('extra', null); } catch {}
      return load('extra') === undefined;
    `, { store });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, true);
    const overflow = await sandbox.execute("return 1", { store: { ...store, extra: null } });
    assert.equal(overflow.ok, false);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("exit succeeds with state writes and stops host calls even when caught", async () => {
  let called = false;
  const sandbox = new CodeModeSandbox({ tools: [{ name: "sideEffect", execute: () => { called = true; } }] });
  try {
    const result = await sandbox.execute(`
      store('count', 2); text('before'); try { exit(); } catch {}
      await tools.sideEffect(); text('after'); return 9;
    `);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    assert.equal(called, false);
    assert.deepEqual(result.output, [{ type: "text", text: "before" }]);
    if (result.ok) {
      assert.equal(result.value, undefined);
      assert.deepEqual(result.storeWrites, { set: { count: 2 }, delete: [] });
    }
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("console and text outputs preserve their order and console marker", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const result = await sandbox.execute("console.log('first', {n: 1}); text('second'); console.warn('last'); return 3;");
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    assert.deepEqual(result.output, [
      { type: "text", text: 'first {"n":1}', console: true },
      { type: "text", text: "second" },
      { type: "text", text: "last", console: true },
    ]);
    if (result.ok) assert.equal(result.value, 3);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("image outputs accept base64 images and opaque references without fetching URLs", async () => {
  const sandbox = new CodeModeSandbox();
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  try {
    const result = await sandbox.execute(`
      image('data:image/png;base64,${data}');
      image({type: 'image', attachment_id: 'image:one', view: {width: 64}});
      try { image('https://example.com/image.png'); } catch { text('URL rejected'); }
    `);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    assert.deepEqual(result.output, [
      { type: "image", data, mimeType: "image/png" },
      { type: "image", attachment_id: "image:one", view: { width: 64 } },
      { type: "text", text: "URL rejected" },
    ]);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("tool aliases and discovery preserve original names when normalized names collide", async () => {
  const sandbox = new CodeModeSandbox({ tools: ["a-b", "a_b", "a b", "long-tool"].map(name => ({ name, execute: () => name })) });
  try {
    const result = await sandbox.execute(`return {
      values: await Promise.all([tools['a-b'](), tools.a_b(), tools['a b'](), tools.long_tool()]),
      names: ALL_TOOLS.map(tool => tool.name),
      frozen: Object.isFrozen(tools) && Object.isFrozen(ALL_TOOLS)
    };`);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.deepEqual(result.value, { values: ["a-b", "a_b", "a b", "long-tool"], names: ["a-b", "a_b", "a b", "long_tool"], frozen: true });
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("unknown tool members give a discovery hint using only available tools", async () => {
  const sandbox = new CodeModeSandbox({ tools: [{ name: "read", execute: () => "ok" }] });
  try {
    const result = await sandbox.execute("try { await tools.reed({}); } catch (error) { return error.message; }");
    assert.equal(result.ok, true);
    if (result.ok) assert.match(String(result.value), /tools\.reed.*does not exist.*read.*searchTools/);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("empty output still counts toward the exact 100000 item limit", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const exact = await sandbox.execute(`for (let i = 0; i < ${CODEMODE_LIMITS.outputItems}; i++) text('');`);
    assert.equal(exact.ok, true);
    assert.equal(exact.output.length, 100000);
    const extra = await sandbox.execute(`for (let i = 0; i <= ${CODEMODE_LIMITS.outputItems}; i++) text('');`);
    assert.equal(extra.ok, false);
    assert.equal(extra.output.length, 100000);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("failed scripts do not commit state and prototype-like keys remain plain data", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const failed = await sandbox.execute("store('count', 1); throw new Error('fail');");
    assert.equal(failed.ok, false);
    assert.equal("storeWrites" in failed, false);
    const result = await sandbox.execute("store('__proto__', {safe: true}); return [load('count'), load('__proto__')];");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.value, [null, { safe: true }]);
      assert.equal(Object.hasOwn(result.storeWrites.set, "__proto__"), true);
      assert.deepEqual(result.storeWrites.set.__proto__, { safe: true });
    }
    assert.equal(({} as Record<string, unknown>).safe, undefined);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("scripts have no process, require, network or timers, and runs do not share globals", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    await sandbox.execute("globalThis.privateValue = 1;");
    const result = await sandbox.execute("return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof privateValue];");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, Array(5).fill("undefined"));
    for (const source of ["return 1n;", "return () => 1;", "const x = {}; x.x = x; return x;"]) {
      const invalid = await sandbox.execute(source);
      assert.equal(invalid.ok, false);
    }
  } finally { await sandbox.close(); await sandbox.drain(); }
});
