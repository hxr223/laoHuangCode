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
} from "../packages/core/tools/src/index.ts";
import { createTestToolRegistry } from "./test-tool-registry.ts";

// scripts/tools.test.ts runs before the bash-runner workstream lands, so the
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

test("registry composes built-in tools in canonical order", async (t) => {
  const projectRoot = await makeTempDir(t);
  const registry = createTestToolRegistry(projectRoot);

  assert.deepEqual(
    registry.definitions.map((definition) => definition.function.name),
    ["read", "write", "edit", "bash"],
  );
});

test("user can write then read a file", async (t) => {
  const directory = await makeTempDir(t);
  const tools = createTestToolRegistry(directory);

  const written = await tools.execute("write", {
    path: "notes/hello.txt",
    content: "hello\n",
  });
  const read = await tools.execute("read", { path: "notes/hello.txt" });

  assert.equal(written.ok, true);
  assert.deepEqual(read, {
    ok: true,
    content: "hello\n",
    offset: 1,
    limit: null,
    total_lines: 1,
    has_more: false,
  });
});

test("file tools block parent directory traversal", async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(base, "outside.txt"), "secret", "utf8");
  const tools = createTestToolRegistry(root);

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
  const tools = createTestToolRegistry(root);

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
  const tools = createTestToolRegistry(root);

  const result = await tools.execute("edit", {
    path: "app.py",
    edits: [{ old_text: "answer = 41", new_text: "answer = 42" }],
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
  const tools = createTestToolRegistry(root);

  const missing = await tools.execute("edit", {
    path: "items.txt",
    edits: [{ old_text: "absent", new_text: "new" }],
  });
  const ambiguous = await tools.execute("edit", {
    path: "items.txt",
    edits: [{ old_text: "same", new_text: "new" }],
  });

  assert.equal(missing.ok, false);
  assert.equal(ambiguous.ok, false);
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});

test("edit applies multiple non-adjacent replacements against the original", async (t) => {
  const root = await makeTempDir(t);
  const filePath = path.join(root, "app.py");
  await fs.writeFile(filePath, "a = 1\nb = 2\nc = 3\n", "utf8");
  const tools = createTestToolRegistry(root);

  const result = await tools.execute("edit", {
    path: "app.py",
    edits: [
      { old_text: "a = 1", new_text: "a = 10" },
      { old_text: "c = 3", new_text: "c = 30" },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(filePath, "utf8"), "a = 10\nb = 2\nc = 30\n");
});

test("edit batch matches all targets against the original content", async (t) => {
  const root = await makeTempDir(t);
  const filePath = path.join(root, "chain.txt");
  const original = "abc\n";
  await fs.writeFile(filePath, original, "utf8");
  const tools = createTestToolRegistry(root);

  // "xbc" only exists after the first replacement; matching against the
  // original means the second edit cannot see it and the batch must fail.
  const result = await tools.execute("edit", {
    path: "chain.txt",
    edits: [
      { old_text: "abc", new_text: "xbc" },
      { old_text: "xbc", new_text: "ybc" },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error as string, /exactly once/);
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});

test("edit rejects overlapping replacements atomically", async (t) => {
  const root = await makeTempDir(t);
  const filePath = path.join(root, "overlap.txt");
  const original = "abcdef\n";
  await fs.writeFile(filePath, original, "utf8");
  const tools = createTestToolRegistry(root);

  const result = await tools.execute("edit", {
    path: "overlap.txt",
    edits: [
      { old_text: "abc", new_text: "ABC" },
      { old_text: "cde", new_text: "CDE" },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.error as string, /overlap/);
  assert.equal(await fs.readFile(filePath, "utf8"), original);
});

test("edit requires a non-empty edits array", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "app.py"), "answer = 41\n", "utf8");
  const tools = createTestToolRegistry(root);

  const missing = await tools.execute("edit", { path: "app.py" });
  const empty = await tools.execute("edit", { path: "app.py", edits: [] });

  assert.equal(missing.ok, false);
  assert.equal(empty.ok, false);
  assert.equal(
    await fs.readFile(path.join(root, "app.py"), "utf8"),
    "answer = 41\n",
  );
});

test("bash runs in project root and returns process result", async (t) => {
  const directory = await makeTempDir(t);
  const tools = createTestToolRegistry(directory, { runBash: testRunBash });

  const result = await tools.execute("bash", {
    command: "pwd; printf problem >&2",
    description: "print working directory and a stderr marker",
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
  const tools = createTestToolRegistry(directory, {
    bashTimeoutSeconds: 0.01,
    runBash: testRunBash,
  });

  const result = await tools.execute("bash", {
    command: "sleep 1",
    description: "sleep past the timeout",
  });

  assert.equal(result.ok, false);
  assert.match(result.error as string, /timed out/i);
});

test("long tool output is truncated with a marker", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "large.txt"), "abcdefghijklmno", "utf8");
  const tools = createTestToolRegistry(root, { maxOutputChars: 10 });

  const result = await tools.execute("read", { path: "large.txt" });

  const content = result.content as string;
  assert.equal(content.slice(0, 10), "abcdefghij");
  assert.match(content, /truncated/);
});

test("bash does not receive model api keys", async (t) => {
  const directory = await makeTempDir(t);
  const tools = createTestToolRegistry(directory, { runBash: testRunBash });

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
    description: "check model API keys are stripped",
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
  const tools = createTestToolRegistry(root);

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
  const tools = createTestToolRegistry(root, {
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
  const tools = createTestToolRegistry(root, {
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
  const tools = createTestToolRegistry(root, {
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
    { path: "shared.txt", edits: [{ old_text: "one", new_text: "ONE" }] },
    { path: "shared.txt", edits: [{ old_text: "two", new_text: "TWO" }] },
  ];
  const results = await Promise.all(
    edits.map((args) => tools.execute("edit", args)),
  );

  assert.ok(results.every((result) => result.ok));
  assert.equal(await fs.readFile(filePath, "utf8"), "ONE\nTWO\n");
});

test("read pages through a file with offset and limit", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "lines.txt"), "1\n2\n3\n4\n5\n", "utf8");
  const tools = createTestToolRegistry(root);

  const whole = await tools.execute("read", { path: "lines.txt" });
  assert.deepEqual(whole, {
    ok: true,
    content: "1\n2\n3\n4\n5\n",
    offset: 1,
    limit: null,
    total_lines: 5,
    has_more: false,
  });

  const window = await tools.execute("read", {
    path: "lines.txt",
    offset: 2,
    limit: 2,
  });
  assert.deepEqual(window, {
    ok: true,
    content: "2\n3\n",
    offset: 2,
    limit: 2,
    total_lines: 5,
    has_more: true,
  });

  const rest = await tools.execute("read", { path: "lines.txt", offset: 4 });
  assert.deepEqual(rest, {
    ok: true,
    content: "4\n5\n",
    offset: 4,
    limit: null,
    total_lines: 5,
    has_more: false,
  });
});

test("read rejects an out-of-range offset", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "lines.txt"), "1\n2\n", "utf8");
  const tools = createTestToolRegistry(root);

  const beyond = await tools.execute("read", { path: "lines.txt", offset: 3 });
  const zero = await tools.execute("read", { path: "lines.txt", offset: 0 });

  assert.equal(beyond.ok, false);
  assert.match(beyond.error as string, /out of range/);
  assert.equal(zero.ok, false);
});

test("read handles an empty file", async (t) => {
  const root = await makeTempDir(t);
  await fs.writeFile(path.join(root, "empty.txt"), "", "utf8");
  const tools = createTestToolRegistry(root);

  const result = await tools.execute("read", { path: "empty.txt" });

  assert.deepEqual(result, {
    ok: true,
    content: "",
    offset: 1,
    limit: null,
    total_lines: 0,
    has_more: false,
  });
});

test("bash schema requires a description", async (t) => {
  const directory = await makeTempDir(t);
  const tools = createTestToolRegistry(directory, { runBash: testRunBash });

  const bash = tools.definitions.find(
    (definition) => definition.function.name === "bash",
  );
  const required = (bash?.function.parameters as Record<string, unknown>)[
    "required"
  ];
  assert.ok((required as string[]).includes("description"));

  const result = await tools.execute("bash", { command: "true" });
  assert.equal(result.ok, false);
  assert.match(result.error as string, /description/);
});

test("bash runs in workdir inside the project root", async (t) => {
  const directory = await makeTempDir(t);
  await fs.mkdir(path.join(directory, "sub"));
  const tools = createTestToolRegistry(directory, { runBash: testRunBash });

  const result = await tools.execute("bash", {
    command: "pwd",
    description: "print working directory",
    workdir: "sub",
  });

  assert.equal(result.ok, true);
  assert.equal(
    (result.stdout as string).trim(),
    await fs.realpath(path.join(directory, "sub")),
  );
});

test("bash rejects a workdir outside the project root", async (t) => {
  const base = await makeTempDir(t);
  const root = path.join(base, "project");
  await fs.mkdir(root);
  const tools = createTestToolRegistry(root, { runBash: testRunBash });

  const result = await tools.execute("bash", {
    command: "pwd",
    description: "print working directory",
    workdir: "..",
  });

  assert.equal(result.ok, false);
  assert.match(result.error as string, /outside the project root/);
});

test("bash honors timeoutMs over the registry default", async (t) => {
  const directory = await makeTempDir(t);
  const tools = createTestToolRegistry(directory, { runBash: testRunBash });

  const result = await tools.execute("bash", {
    command: "sleep 1",
    description: "sleep past the timeout",
    timeoutMs: 20,
  });

  assert.equal(result.ok, false);
  assert.match(result.error as string, /timed out/i);
});

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
