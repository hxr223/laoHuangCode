import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "./evals/process.ts";
test("watchdog stops an unresponsive process and preserves its output", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "console.log('started'); setInterval(()=>{},1000)"],
    { timeoutMs: 150 },
  );
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /started/u);
  assert.ok(result.durationMs < 4000);
});
test("process runner distinguishes failed exit from timeout", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "console.error('fixture failure');process.exit(4)"],
    { timeoutMs: 1000 },
  );
  assert.equal(result.code, 4);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /fixture failure/u);
});
test("process runner honours cancellation without treating it as success", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { timeoutMs: 5000, signal: controller.signal },
  );
  assert.equal(result.cancelled, true);
  assert.notEqual(result.code, 0);
});
