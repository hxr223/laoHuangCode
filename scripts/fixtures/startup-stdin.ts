import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { defaultInputFn, defaultSecretInputFn } from "../../apps/cli/src/repl.ts";

const resultPath = process.argv[2];
const mode = process.argv[3] ?? "input";
let ticks = 0;
const timer = setInterval(() => {
  ticks++;
  if (ticks === 1) process.stdout.write("EVENT_LOOP_ALIVE\n");
}, 50);
let result: Record<string, unknown>;
try {
  const choice = await defaultInputFn("Select option: ");
  assert.equal(choice, "13");
  const secret = await defaultSecretInputFn("Enter API key: ");
  assert.equal(secret, "offline-key");
  assert.equal(await defaultInputFn("Next option: "), "2");
  result = { ok: true, ticks };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? error.name : String(error) };
  if (mode === "input") process.exitCode = 1;
} finally {
  clearInterval(timer);
}
result.raw = process.stdin.isRaw ?? false;
result.dataListeners = process.stdin.listenerCount("data");
result.paused = process.stdin.isPaused();
if (resultPath) writeFileSync(resultPath, JSON.stringify(result));
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
