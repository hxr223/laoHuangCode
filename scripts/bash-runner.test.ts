import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// NOTE: Node 22 type stripping cannot resolve ".js" specifiers to ".ts"
// sources, so test files import the ".ts" path directly (tsc only covers src/).
import {
  ToolExecutionContext,
  runBash,
} from "../packages/shell/bash-local/src/index.ts";

interface RecordedEvent {
  kind: string;
  source: string;
  session_id: string;
  task_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

/** Minimal structural stand-in for the EventBus owned by another workstream. */
class FakeEventBus {
  private events: RecordedEvent[] = [];

  publish(kind: string, options: Omit<RecordedEvent, "kind">): void {
    this.events.push({ kind, ...options });
  }

  drain(): RecordedEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }
}

/** Minimal structural stand-in for the CancelToken owned by another workstream. */
class FakeCancelToken {
  private cancelled = false;
  private reasonValue: string | null = null;

  cancel(reason?: string): void {
    this.cancelled = true;
    this.reasonValue = reason ?? null;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  get reason(): string | null {
    return this.reasonValue;
  }
}

async function withTempDir(
  fn: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "bash-runner-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("streams stdout and stderr as separate events", async () => {
  await withTempDir(async (directory) => {
    const events = new FakeEventBus();
    const context = new ToolExecutionContext({
      sessionId: "session-1",
      taskId: "task-1",
      toolCallId: "tool-1",
      eventSink: events,
    });

    const command = "printf out; printf err >&2";
    const result = await runBash(command, {
      cwd: directory,
      timeout: 2,
      maxOutputBytes: 100,
      context,
    });

    const published = events.drain();
    assert.equal(result.status, "completed");
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(published[0]?.kind, "tool.started");
    assert.equal(published[published.length - 1]?.kind, "tool.finished");
    assert.deepEqual(published[0]?.payload, {
      name: "bash",
      arguments: { command },
    });
    const finishedPayload = published[published.length - 1]?.payload ?? {};
    assert.ok("duration_ms" in finishedPayload);
    assert.equal(finishedPayload["truncated"], false);

    const deltas = published.filter(
      (event) => event.kind === "tool.output_snapshot",
    );
    const byStream: Record<string, string> = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      byStream[stream] = deltas
        .filter((event) => event.payload["stream"] === stream)
        .map((event) => String(event.payload["text"]))
        .at(-1) ?? "";
    }
    assert.deepEqual(byStream, { stdout: "out", stderr: "err" });
    assert.ok(
      published.every((event) => event.correlation_id === "tool-1"),
    );
  });
});

test("preserves utf8 split across pipe reads", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash(
      "printf '\\344\\275'; sleep 0.01; printf '\\240'",
      { cwd: directory, timeout: 2, maxOutputBytes: 100 },
    );

    assert.equal(result.stdout, "你");
  });
});

test("final output keeps a bounded tail and saves the complete output", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash("printf 0123456789ABCDEF", {
      cwd: directory,
      timeout: 2,
      maxOutputBytes: 10,
      outputDirectory: path.join(directory, "logs"),
    });

    assert.equal(result.stdout, "6789ABCDEF");
    assert.equal(result.outputFileComplete, true);
    assert.equal(result.truncated, true);
    assert.ok(result.durationMs >= 0);
  });
});

test("nonzero exit is failed", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash("printf problem >&2; exit 7", {
      cwd: directory,
      timeout: 2,
      maxOutputBytes: 100,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "problem");
  });
});

test("timeout terminates process group", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash("sleep 10", {
      cwd: directory,
      timeout: 0.02,
      maxOutputBytes: 100,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "timed_out");
    assert.ok((result.error ?? "").includes("timed out"));
  });
});

test("cancel token stops running command", async () => {
  await withTempDir(async (directory) => {
    const token = new FakeCancelToken();
    let markBeforeSeen!: () => void;
    const beforeSeen = new Promise<void>((resolve) => {
      markBeforeSeen = resolve;
    });
    const sink = (kind: string, payload: Record<string, unknown>) => {
      if (
        kind === "tool.output_snapshot" &&
        payload["stream"] === "stdout" &&
        String(payload["text"] ?? "").includes("before")
      ) {
        markBeforeSeen();
      }
    };
    const context = new ToolExecutionContext({ cancelToken: token, eventSink: sink });
    // Cancel only after "before" is observable; a fixed delay races with
    // login-shell startup on slow CI runners.
    const canceller = (async () => {
      await Promise.race([
        beforeSeen,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      token.cancel("user requested");
    })();
    try {
      const result = await runBash("printf before; sleep 10; printf after", {
        cwd: directory,
        timeout: 5,
        maxOutputBytes: 100,
        context,
      });

      assert.equal(result.status, "cancelled");
      assert.equal(result.error, "user requested");
      assert.ok(result.stdout.includes("before"));
      assert.ok(!result.stdout.includes("after"));
    } finally {
      await canceller;
    }
  });
});

test("stdin is closed for noninteractive commands", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash(
      "if read value; then printf open; else printf closed; fi",
      { cwd: directory, timeout: 2, maxOutputBytes: 100 },
    );

    assert.equal(result.stdout, "closed");
  });
});

test("removes terminal control sequences", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash(
      "printf '\\033[31mred\\033[0m\\033]0;title\\007safe\\b'",
      { cwd: directory, timeout: 2, maxOutputBytes: 100 },
    );

    assert.equal(result.stdout, "redsafe");
    assert.ok(!result.stdout.includes("\x1b"));
  });
});

test("spawn error has spawn_failed status", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash("true", {
      cwd: path.join(directory, "does-not-exist"),
      timeout: 2,
      maxOutputBytes: 100,
    });

    assert.equal(result.status, "spawn_failed");
    assert.ok((result.error ?? "").length > 0);
  });
});

test("removes model keys from explicit environment", async () => {
  await withTempDir(async (directory) => {
    const environment: Record<string, string | undefined> = {
      ...process.env,
      OPENAI_API_KEY: "secret",
    };
    const result = await runBash('printf %s "$OPENAI_API_KEY"', {
      cwd: directory,
      timeout: 2,
      maxOutputBytes: 100,
      env: environment,
    });

    assert.equal(result.stdout, "");
  });
});

test("returns after shell exit when a quiet descendant retains stdout", { skip: process.platform === "win32" }, async () => {
  await withTempDir(async (directory) => {
    const result = await runBash('sleep 5 & printf "%s\\nready" "$!"', {
      cwd: directory,
      timeout: 2,
      maxOutputBytes: 100,
    });
    try {
      assert.equal(result.status, "completed");
      assert.ok(result.stdout.endsWith("ready"));
      assert.equal(result.outputComplete, false);
    } finally {
      const pid = Number(result.stdout.split("\n")[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
  });
});

test("continues collecting active descendant output after shell exit", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash(
      // External sleep startup can exceed the inherited-pipe idle deadline on
      // loaded CI hosts. Keep this fixture continuously writing instead.
      '(for i in 1 2 3 4 5 6; do printf chunk; done; printf tail) & printf ready',
      { cwd: directory, timeout: 3, maxOutputBytes: 100 },
    );
    assert.equal(result.status, "completed");
    assert.ok(result.stdout.includes("tail"));
    assert.equal(result.stdout.match(/chunk/g)?.length, 6);
    assert.equal(result.truncated, false);
  });
});

test("quiet foreground commands are not mistaken for leaked pipes", async () => {
  await withTempDir(async (directory) => {
    const result = await runBash("sleep 0.3; printf done", {
      cwd: directory, timeout: 3, maxOutputBytes: 100,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.stdout, "done");
    assert.equal(result.truncated, false);
  });
});
