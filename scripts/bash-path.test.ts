import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveBashPath, runBash, ToolExecutionContext } from "../packages/shell/bash-local/src/index.ts";
import { createBashToolDefinition } from "../packages/shell/tool-bash/src/index.ts";

test("explicit Bash overrides defaults and expands home paths", () => {
  assert.equal(resolveBashPath({
    shellPath: "~/custom bash", platform: "darwin", homeDirectory: "/home/test",
    isExecutable: () => true,
  }), "/home/test/custom bash");
  assert.equal(resolveBashPath({
    shellPath: "~\\custom bash.exe", platform: "win32", homeDirectory: "C:\\Users\\Test",
    isExecutable: () => true,
  }), "C:\\Users\\Test\\custom bash.exe");
  assert.equal(resolveBashPath({ shellPath: "~/bash", isExecutable: () => true }), join(homedir(), "bash"));
});

test("invalid explicit paths fail without falling back", () => {
  assert.throws(() => resolveBashPath({ shellPath: "bash" }), /absolute Bash path/);
  assert.throws(() => resolveBashPath({
    shellPath: "/missing/bash", platform: "linux", isExecutable: (p) => p === "/bin/bash",
  }), /Configured Bash is missing/);
});

test("Unix prefers system Bash and falls back to PATH in order", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(resolveBashPath({ platform, env: { PATH: "/first:/second" }, isExecutable: () => true }), "/bin/bash");
    assert.equal(resolveBashPath({
      platform, env: { PATH: "/first:/second" }, isExecutable: (p) => p !== "/bin/bash",
    }), "/first/bash");
    assert.throws(() => resolveBashPath({ platform, env: {}, isExecutable: () => false }), /Bash not found/);
  }
});

test("Windows prefers Git install directories then searches case-insensitive PATH", () => {
  const env = { PROGRAMFILES: "C:\\Program Files", "ProgramFiles(x86)": "D:\\Apps", Path: '"E:\\Custom Git\\bin";F:\\bin' };
  const candidates = ["C:\\Program Files\\Git\\bin\\bash.exe", "D:\\Apps\\Git\\bin\\bash.exe", "E:\\Custom Git\\bin\\bash.exe", "F:\\bin\\bash.exe"];
  for (let index = 0; index < candidates.length; index++) {
    const available = candidates.slice(index);
    assert.equal(resolveBashPath({ platform: "win32", env, isExecutable: (p) => available.includes(p) }), candidates[index]);
  }
});

test("Windows skips legacy WSL launchers and keeps looking", () => {
  assert.equal(resolveBashPath({
    platform: "win32", env: { PATH: "C:\\Windows\\System32;D:\\Git\\bin" }, isExecutable: () => true,
  }), "D:\\Git\\bin\\bash.exe");
  assert.throws(() => resolveBashPath({
    platform: "win32", shellPath: "C:\\Windows\\Sysnative\\bash.exe", isExecutable: () => true,
  }), /legacy WSL launcher/);
  assert.throws(() => resolveBashPath({
    platform: "win32", env: { PATH: "C:\\Windows\\System32" }, isExecutable: () => true,
  }), /Install Git for Windows/);
});

test("PATH lookup skips empty and relative entries", () => {
  assert.equal(resolveBashPath({
    platform: "linux", env: { PATH: ":.:project-bin:/opt/bin" }, isExecutable: (p) => p !== "/bin/bash",
  }), "/opt/bin/bash");
});

test("filesystem checks reject directories and non-executable files", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "bash-path-test-"));
  try {
    assert.throws(() => resolveBashPath({ shellPath: directory }), /not executable/);
    const file = join(directory, "bash");
    writeFileSync(file, "fixture");
    chmodSync(file, 0o600);
    assert.throws(() => resolveBashPath({ shellPath: file }), /not executable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configured path reaches the real Bash runner through the tool", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "bash-path-test-"));
  try {
    const shellPath = join(directory, "custom bash");
    symlinkSync(resolveBashPath(), shellPath);
    const tool = createBashToolDefinition({ projectRoot: directory, shellPath });
    const result = await tool.execute({ command: 'printf %s "$BASH"', description: "Inspect Bash path" }, new ToolExecutionContext());
    assert.equal(result["status"], "completed");
    assert.equal(result["stdout"], shellPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolution failure produces spawn_failed and a terminal event", async () => {
  const events: string[] = [];
  const result = await runBash("true", {
    cwd: process.cwd(), shellPath: join(tmpdir(), "missing-bash-path-test", "bash"), timeout: 1, maxOutputBytes: 100,
    context: new ToolExecutionContext({ eventSink: (kind) => { events.push(kind); } }),
  });
  assert.equal(result.status, "spawn_failed");
  assert.match(result.error ?? "", /Configured Bash is missing/);
  assert.deepEqual(events, ["tool.finished"]);
});
