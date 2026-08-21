import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ToolRegistry,
  type RunBash,
  type ToolExecutionContextLike,
  type ToolResult,
} from "../src/tools.ts";

// test/tools.test.ts runs before the bash-runner workstream lands, so the
// bash cases below exercise a real (but minimal) runner built on
// node:child_process. It mirrors the observable contract tools.ts relies on:
// run in cwd, strip model API keys from the environment, enforce the timeout,
// and resolve with a plain result object.
const STRIPPED_ENV_NAMES = [
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "LAOHUANG_API_KEY",
];

const testRunBash: RunBash = (command, options) =>
  new Promise<ToolResult>((resolve) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined && !STRIPPED_ENV_NAMES.includes(key)) {
        env[key] = value;
      }
    }
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutSeconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: "spawn_failed", error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          status: "timed_out",
          stdout,
          stderr,
          error: `Bash command timed out after ${options.timeoutSeconds} seconds`,
        });
      } else if (code === 0) {
        resolve({ ok: true, status: "completed", exit_code: code, stdout, stderr });
      } else {
        resolve({
          ok: false,
          status: "failed",
          exit_code: code,
          stdout,
          stderr,
          error: `Bash command exited with code ${code}`,
        });
      }
    });
  });

async function makeTempDir(t: import("node:test").TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tools-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("user can write then read a file", async (t) => {
  const directory = await makeTempDir(t);
  const tools = new ToolRegistry(directory);

  const written = await tools.execute("write", {
    path: "notes/hello.txt",
    content: "hello\n",
  });
  const read = await tools.execute("read", { path: "notes/hello.txt" });

  assert.equal(written.ok, true);
  assert.deepEqual(read, { ok: true, content: "hello\n" });
});

test("file tools block parent directory traversal", async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(base, "outside.txt"), "secret", "utf8");
  const tools = new ToolRegistry(root);

  const read = await tools.execute("read", { path: "../outside.txt" });
  const write = await tools.execute("write", {
    path: "../created.txt",
    content: "escaped",
  });

  assert.equal(read.ok, false);
  assert.equal(write.ok, false);
  assert.equal(await exists(path.join(base, "created.txt")), false);
});

test("file tools block symlink escape", async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "link"), "dir");
  const tools = new ToolRegistry(root);

  const result = await tools.execute("write", {
    path: "link/escaped.txt",
    content: "escaped",
  });

  assert.equal(result.ok, false);
  assert.equal(await exists(path.join(outside, "escaped.txt")), false);
});

test("user can replace one exact text match", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "app.py"), "answer = 41\n", "utf8");
  const tools = new ToolRegistry(root);

  const result = await tools.execute("edit", {
    path: "app.py",
    old_text: "answer = 41",
    new_text: "answer = 42",
  });

  assert.equal(result.ok, true);
  assert.equal(
    await fs.readFile(path.join(root, "app.py"), "utf8"),
    "answer = 42\n",
  );
});

test("edit refuses missing or ambiguous text", async (t) => {
  const root = await makeTempDir(t);
  const filePath = path.join(root, "items.txt");
  const original = "same\nsame\n";
  await fs.writeFile(filePath, original, "utf8");
  const tools = new ToolRegistry(root);

  const missing = await tools.execute("edit", {
    path: "items.txt",
    old_text: "absent",
    new_text: "new",
  });
  const ambiguous = await tools.execute("edit", {
    path: "items.txt",
    old_text: "same",
    new_text: "new",
  });

  assert.equal(missing.ok, false);
  assert.equal(ambiguous.ok, false);
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});

test("bash runs in project root and returns process result", async (t) => {
  const directory = await makeTempDir(t);
  const tools = new ToolRegistry(directory, { runBash: testRunBash });

  const result = await tools.execute("bash", {
    command: "pwd; printf problem >&2",
  });

  assert.equal(result.ok, true);
  assert.equal(result.exit_code, 0);
  assert.equal(
    (result.stdout as string).trim(),
    await fs.realpath(directory),
  );
  assert.equal(result.stderr, "problem");
});

test("bash timeout returns an error", async (t) => {
  const directory = await makeTempDir(t);
  const tools = new ToolRegistry(directory, {
    bashTimeoutSeconds: 0.01,
    runBash: testRunBash,
  });

  const result = await tools.execute("bash", { command: "sleep 1" });

  assert.equal(result.ok, false);
  assert.match(result.error as string, /timed out/i);
});

test("long tool output is truncated with a marker", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "large.txt"), "abcdefghijklmno", "utf8");
  const tools = new ToolRegistry(root, { maxOutputChars: 10 });

  const result = await tools.execute("read", { path: "large.txt" });

  const content = result.content as string;
  assert.equal(content.slice(0, 10), "abcdefghij");
  assert.match(content, /truncated/);
});

test("bash does not receive model api keys", async (t) => {
  const directory = await makeTempDir(t);
  const tools = new ToolRegistry(directory, { runBash: testRunBash });

  process.env.OPENAI_API_KEY = "openai-secret";
  process.env.DEEPSEEK_API_KEY = "deepseek-secret";
  process.env.LAOHUANG_API_KEY = "custom-secret";
  t.after(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.LAOHUANG_API_KEY;
  });

  const result = await tools.execute("bash", {
    command:
      'printf \'%s|%s|%s\' "$OPENAI_API_KEY" "$DEEPSEEK_API_KEY" "$LAOHUANG_API_KEY"',
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "||");
});

test("cancelled file tool does not mutate file", async (t) => {
  const root = await makeTempDir(t);
  const context: ToolExecutionContextLike = {
    isCancelled: () => true,
    cancellationReason: "stop now",
  };
  const tools = new ToolRegistry(root);

  const result = await tools.execute(
    "write",
    { path: "never.txt", content: "no" },
    context,
  );

  assert.equal(result.status, "cancelled");
  assert.equal(result.error, "stop now");
  assert.equal(await exists(path.join(root, "never.txt")), false);
});

test("writes to the same file are serialized", async (t) => {
  const root = await makeTempDir(t);
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const tools = new ToolRegistry(root, {
    io: {
      readFile: (target) => fs.readFile(target, "utf8"),
      writeFile: async (target, content) => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        try {
          await sleep(50);
          await fs.writeFile(target, content, "utf8");
        } finally {
          activeWrites -= 1;
        }
      },
    },
  });

  const results = await Promise.all(
    ["first", "second"].map((content) =>
      tools.execute("write", { path: "shared.txt", content }),
    ),
  );

  assert.ok(results.every((result) => result.ok));
  assert.equal(maximumActiveWrites, 1);
});

test("writes to different files can run concurrently", async (t) => {
  const root = await makeTempDir(t);
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const tools = new ToolRegistry(root, {
    io: {
      readFile: (target) => fs.readFile(target, "utf8"),
      writeFile: async (target, content) => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        try {
          await sleep(50);
          await fs.writeFile(target, content, "utf8");
        } finally {
          activeWrites -= 1;
        }
      },
    },
  });

  const results = await Promise.all(
    [
      ["first.txt", "first"],
      ["second.txt", "second"],
    ].map(([name, content]) =>
      tools.execute("write", { path: name as string, content: content as string }),
    ),
  );

  assert.ok(results.every((result) => result.ok));
  assert.equal(maximumActiveWrites, 2);
});

test("edits to the same file do not lose updates", async (t) => {
  const root = await makeTempDir(t);
  const filePath = path.join(root, "shared.txt");
  await fs.writeFile(filePath, "one\ntwo\n", "utf8");
  const tools = new ToolRegistry(root, {
    io: {
      readFile: async (target) => {
        const content = await fs.readFile(target, "utf8");
        if (path.basename(target) === "shared.txt") {
          await sleep(50);
        }
        return content;
      },
      writeFile: (target, content) => fs.writeFile(target, content, "utf8"),
    },
  });

  const edits = [
    { path: "shared.txt", old_text: "one", new_text: "ONE" },
    { path: "shared.txt", old_text: "two", new_text: "TWO" },
  ];
  const results = await Promise.all(
    edits.map((args) => tools.execute("edit", args)),
  );

  assert.ok(results.every((result) => result.ok));
  assert.equal(await fs.readFile(filePath, "utf8"), "ONE\nTWO\n");
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
