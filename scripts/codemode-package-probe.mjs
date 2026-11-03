import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const app = resolve(process.argv[2] ?? 'apps/cli');
const entry = join(app, 'dist/codemode-worker.js');
assert.ok(existsSync(entry), 'Published Code Mode Worker is missing');
assert.match(readFileSync(join(app, 'THIRD_PARTY_NOTICES'), 'utf8'), /Mario Zechner/);
const require = createRequire(join(app, 'package.json'));
const wasmPath = require.resolve('quickjs-wasi/quickjs.wasm');
assert.equal(JSON.parse(readFileSync(join(dirname(wasmPath), 'package.json'), 'utf8')).version, '3.6.2');
const wasm = await WebAssembly.compile(readFileSync(wasmPath));
const interrupt = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(pathToFileURL(entry), { workerData: {
  code: 'return await tools.double({value: 21});',
  tools: [{ name: 'double', jsName: 'double', description: 'Local packaging fixture' }],
  globals: [], store: {}, memoryLimitBytes: 268435456, wasm, interrupt: interrupt.buffer,
} });
let timer;
try {
  await new Promise((resolveResult, reject) => {
    timer = setTimeout(() => reject(new Error('Packaged Code Mode Worker timed out')), 10000);
    worker.on('error', reject);
    worker.on('exit', code => reject(new Error(`Packaged Worker exited before its result: ${code}`)));
    worker.on('message', message => {
      try {
        if (message && typeof message === 'object' && ('watch:import' in message || 'watch:require' in message)) return;
        if (message.type === 'call') {
          assert.equal(message.target, 'tool'); assert.equal(message.name, 'double');
          assert.deepEqual(JSON.parse(message.args), { value: 21 });
          worker.postMessage({ type: 'result', id: message.id, ok: true, payload: '42' });
        } else if (message.type === 'done') {
          assert.equal(message.ok, true, message.error);
          assert.equal(JSON.parse(message.value), 42);
          assert.equal(message.writes, '[]');
          resolveResult();
        } else throw new Error(`Unexpected packaged Worker message: ${message.type}`);
      } catch (error) { reject(error); }
    });
  });
  console.log('packaged codemode worker passed');
} finally {
  clearTimeout(timer);
  Atomics.store(interrupt, 0, 1);
  await worker.terminate();
}
