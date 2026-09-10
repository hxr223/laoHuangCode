import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/startup-stdin.ts", import.meta.url));

test("default prompts leave the event loop running and preserve batched pipe input", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [fixture], { stdio: "pipe" });
  const closed = once(child, "close");
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  try {
    for (let i = 0; i < 100 && !output.includes("EVENT_LOOP_ALIVE"); i++) await delay(20);
    assert.ok(output.includes("EVENT_LOOP_ALIVE"), "waiting for stdin blocked the event loop");
    child.stdin.end("13\noffline-key\n2\n");
    const [code] = await closed;
    assert.equal(code, 0, output);
    assert.ok(output.includes('"ok":true'), output);
    assert.ok(output.includes('"dataListeners":0'), output);
    assert.equal(output.includes("offline-key"), false);
  } finally {
    child.kill();
    await closed;
  }
});

const hasTmux = process.platform !== "win32" && spawnSync("tmux", ["-V"]).status === 0;
test("real TTY prompts wait for typing, hide secrets, and restore input ownership", { skip: !hasTmux, timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-stdin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runTmux = (args: string[]): string => {
    const result = spawnSync("tmux", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  for (const mode of ["input", "cancel", "eof"]) {
    const session = `laohuang-stdin-${process.pid}-${mode}`;
    const resultPath = join(directory, `${mode}.json`);
    try {
      runTmux(["new-session", "-d", "-s", session, "-x", "100", "-y", "24",
        [process.execPath, fixture, resultPath, mode].map(quote).join(" ")]);
      runTmux(["set-option", "-t", session, "remain-on-exit", "on"]);
      const capture = (): string => runTmux(["capture-pane", "-t", session, "-p", "-S", "-100"]);
      const waitFor = async (text: string): Promise<void> => {
        for (let i = 0; i < 100; i++) {
          if (capture().includes(text)) return;
          await delay(25);
        }
        assert.fail(`TTY did not show ${text}: ${capture()}`);
      };
      await waitFor("Select option:");
      runTmux(["send-keys", "-t", session, "13", "Enter"]);
      await waitFor("Enter API key:");
      await delay(150);
      assert.equal(existsSync(resultPath), false, "secret prompt exited before input");
      if (mode === "input") {
        runTmux(["send-keys", "-t", session, "offline-"]);
        await delay(100);
        assert.equal(existsSync(resultPath), false, "secret prompt failed between keystrokes");
        runTmux(["send-keys", "-t", session, "kez", "BSpace", "y", "Enter"]);
        await waitFor("Next option:");
        runTmux(["send-keys", "-t", session, "2", "Enter"]);
      } else {
        runTmux(["send-keys", "-t", session, mode === "cancel" ? "C-c" : "C-d"]);
      }
      for (let i = 0; i < 100 && !existsSync(resultPath); i++) await delay(25);
      assert.ok(existsSync(resultPath), capture());
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      assert.equal(result.ok, mode === "input");
      if (mode !== "input") assert.equal(result.error, mode === "cancel" ? "PromptCancelledError" : "PromptEofError");
      assert.equal(result.raw, false);
      assert.equal(result.dataListeners, 0);
      assert.equal(result.paused, true);
      assert.equal(capture().includes("offline-"), false, "secret input was echoed");
    } finally {
      spawnSync("tmux", ["kill-session", "-t", session]);
    }
  }
});
