import assert from "node:assert/strict";
import childProcess, { ChildProcess, type ExecFileOptions, type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { runBash, ToolExecutionContext } from "../packages/shell/bash-local/src/index.ts";

function windowsFixture(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 12345 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const starts: { file: string; args: readonly string[]; options: SpawnOptions }[] = [];
  const kills: { file: string; args: readonly string[]; options: ExecFileOptions }[] = [];
  let cleanup: (done: (error: Error | null) => void) => void = (done) => { done(null); };
  const keepAlive = setInterval(() => {}, 1000);
  const spawnMock = t.mock.method(childProcess, "spawn", (file: string, args: readonly string[], options: SpawnOptions) => {
    starts.push({ file, args, options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  t.mock.method(childProcess, "execFile", (
    file: string, args: readonly string[], options: ExecFileOptions, done: (error: Error | null) => void,
  ) => {
    kills.push({ file, args, options });
    cleanup(done);
    return new ChildProcess();
  });
  const fallback = t.mock.method(child, "kill", () => false);
  const unref = t.mock.method(child, "unref", () => {});
  const signals = t.mock.method(process, "kill", () => { throw new Error("Unexpected Unix signal"); });
  syncBuiltinESMExports();
  t.after(() => {
    clearInterval(keepAlive);
    child.stdout?.destroy();
    child.stderr?.destroy();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
  });
  const exit = () => {
    child.stdout?.push(null);
    child.stderr?.push(null);
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return { child, starts, kills, fallback, unref, signals, spawnMock, exit,
    setCleanup: (handler: typeof cleanup) => { cleanup = handler; },
  };
}

test("Windows starts Bash without detachment or a visible console and preserves argv", async (t) => {
  const fixture = windowsFixture(t);
  const command = 'printf "%s" "a b"\nprintf done';
  const execution = runBash(command, {
    cwd: process.cwd(), shellPath: process.execPath, timeout: 2, maxOutputBytes: 100,
    context: new ToolExecutionContext({ eventSink: (kind) => {
      if (kind === "tool.started") setImmediate(fixture.exit);
    } }),
  });
  const result = await execution;
  assert.equal(result.status, "completed");
  assert.equal(fixture.starts[0]?.file, process.execPath);
  assert.deepEqual(fixture.starts[0]?.args, ["-lc", command]);
  assert.equal(fixture.starts[0]?.options.detached, false);
  assert.equal(fixture.starts[0]?.options.windowsHide, true);
  assert.deepEqual(fixture.starts[0]?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(fixture.kills.length, 0);
});

for (const reason of ["cancelled", "timed_out"] as const) {
  test(`Windows ${reason} waits for taskkill even when the shell exits first`, async (t) => {
    const fixture = windowsFixture(t);
    let cancelled = false;
    let cleanupFinished = false;
    fixture.setCleanup((done) => {
      fixture.exit();
      setTimeout(() => { cleanupFinished = true; done(null); }, 50);
    });
    const result = await runBash("sleep 10", {
      cwd: process.cwd(), shellPath: process.execPath, timeout: reason === "timed_out" ? 0.02 : 2,
      maxOutputBytes: 100,
      context: new ToolExecutionContext({
        cancelToken: { isCancelled: () => cancelled },
        eventSink: (kind) => { if (kind === "tool.started" && reason === "cancelled") cancelled = true; },
      }),
    });
    assert.equal(result.status, reason);
    assert.equal(cleanupFinished, true);
    assert.equal(fixture.kills.length, 1);
    assert.equal(fixture.kills[0]?.file, win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"));
    assert.deepEqual(fixture.kills[0]?.args, ["/F", "/T", "/PID", "12345"]);
    assert.equal(fixture.kills[0]?.options.windowsHide, true);
    assert.equal(fixture.kills[0]?.options.timeout, 5000);
    assert.equal(fixture.signals.mock.callCount(), 0);
    assert.equal(fixture.fallback.mock.callCount(), 0);
    assert.equal(result.error?.includes("cleanup failed"), false);
  });
}

for (const failure of ["nonzero", "spawn", "no-exit"] as const) {
  test(`Windows cleanup ${failure} cannot leave the runner waiting forever`, async (t) => {
    const fixture = windowsFixture(t);
    fixture.setCleanup((done) => {
      if (failure === "spawn") throw new Error("taskkill ENOENT");
      done(failure === "nonzero" ? new Error("Access denied") : null);
    });
    const result = await runBash("sleep 10", {
      cwd: process.cwd(), shellPath: process.execPath, timeout: 0.01, maxOutputBytes: 100,
    });
    assert.equal(result.status, "timed_out");
    assert.equal(result.exitCode, null);
    assert.equal(result.outputComplete, false);
    assert.match(result.error ?? "", /Process cleanup failed/);
    assert.match(result.error ?? "", failure === "no-exit" ? /did not exit/ : failure === "spawn" ? /ENOENT/ : /Access denied/);
    assert.equal(fixture.kills.length, 1);
    assert.equal(fixture.fallback.mock.callCount(), failure === "no-exit" ? 0 : 1);
    assert.equal(fixture.unref.mock.callCount(), 1);
    assert.equal(fixture.signals.mock.callCount(), 0);
  });
}

test("a synchronous spawn error is returned as spawn_failed", async (t) => {
  const fixture = windowsFixture(t);
  fixture.spawnMock.mock.mockImplementation(() => { throw new Error("invalid spawn argument"); });
  const result = await runBash("true", {
    cwd: process.cwd(), shellPath: process.execPath, timeout: 1, maxOutputBytes: 100,
  });
  assert.equal(result.status, "spawn_failed");
  assert.match(result.error ?? "", /invalid spawn argument/);
  assert.equal(fixture.kills.length, 0);
});

for (const mode of ["cancel", "exit"] as const) {
  test(`native Windows process tree ${mode}`, { skip: process.platform !== "win32", timeout: 15000 }, async () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/bash-process-tree.cjs", import.meta.url));
    const command = [process.execPath, fixturePath, mode]
      .map((value) => `'${value.replaceAll("\\", "/").replaceAll("'", `'"'"'`)}'`).join(" ");
    let cancelled = false;
    let pid: number | undefined;
    let output = "";
    try {
      const result = await runBash(command, {
        cwd: process.cwd(), timeout: 5, maxOutputBytes: 1000,
        context: new ToolExecutionContext({
          cancelToken: { isCancelled: () => cancelled },
          eventSink: (kind, payload) => {
            if (kind !== "tool.output_snapshot" || payload["stream"] !== "stdout") return;
            output = String(payload["text"]);
            const match = output.match(/worker:(\d+)\r?\n/);
            if (match) { pid = Number(match[1]); cancelled = mode === "cancel"; }
          },
        }),
      });
      assert.ok(pid !== undefined);
      assert.equal(result.status, mode === "cancel" ? "cancelled" : "completed");
      if (mode === "cancel") {
        assert.equal(result.error?.includes("cleanup failed"), false);
        assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
      } else {
        assert.equal(result.outputComplete, false);
      }
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
  });
}
