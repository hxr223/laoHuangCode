import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runBash, ToolExecutionContext } from "../packages/shell/bash-local/src/index.ts";
import { EventBus, EventFactory, EventProjector } from "../packages/core/runtime-protocol/src/events.ts";
import { TerminalUI, PlainEventSink } from "../packages/terminal/tui/src/tui/ui.ts";
import { CodingAgent } from "../packages/core/agent-runtime/src/index.ts";
import { createBashToolDefinition } from "../packages/shell/tool-bash/src/index.ts";
import { ToolRegistry } from "../packages/core/tools/src/index.ts";
import type { ModelAdapter, ModelRequest, ModelResult } from "@laohuang/llm";
import { BashOutput } from "../packages/shell/bash-local/src/bash-output.ts";

async function fixture(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "bash-output-"));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function event(kind: string, payload: Record<string, unknown>, id = "call-1") {
  return { kind, correlation_id: id, payload };
}

test("large Bash reads become bounded snapshots and recoverable output files", async () => {
  await fixture(async (directory) => {
    const original = "first\n" + "你🙂\t\"".repeat(20_000) + "\nlast";
    await writeFile(join(directory, "input"), original);
    const events: ReturnType<typeof event>[] = [];
    const factory = new EventFactory();
    const result = await runBash("cat input; printf problem >&2", {
      cwd: directory, timeout: 5, outputDirectory: join(directory, "logs"),
      context: new ToolExecutionContext({ eventSink: async (kind, payload) => {
        factory.create(kind, {
          source: "tool", session_id: "session", task_id: "task", correlation_id: "call-1", payload,
        });
        events.push(event(kind, payload));
      } }),
    });
    assert.equal(result.status, "completed");
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 50 * 1024);
    assert.ok(result.stdout.endsWith("\nlast"));
    assert.equal(result.stderr, "problem");
    assert.ok(!result.stdout.includes("�"));
    const snapshots = events.filter((item) => item.kind === "tool.output_snapshot");
    assert.ok(snapshots.length > 0);
    assert.equal(events.some((item) => item.kind === "tool.output_delta"), false);
    assert.ok(snapshots.every((item) => Buffer.byteLength(String(item.payload.text)) <= 50 * 1024));
    assert.equal(events.at(-1)?.kind, "tool.finished");
    const data = result.asDict();
    const files = data.output_files as { stdout: string; stderr: string };
    assert.equal(await readFile(files.stdout, "utf8"), original);
    assert.equal(await readFile(files.stderr, "utf8"), "problem");
    assert.equal(data.output_file_complete, true);
    if (process.platform !== "win32") assert.equal((await stat(files.stdout)).mode & 0o777, 0o600);
  });
});

test("small Bash output is returned whole without creating output files", async () => {
  await fixture(async (directory) => {
    const result = await runBash("printf hello; printf warning >&2", {
      cwd: directory, timeout: 5, outputDirectory: join(directory, "logs"),
    });
    assert.equal(result.stdout, "hello");
    assert.equal(result.stderr, "warning");
    assert.equal(result.truncated, false);
    assert.equal(result.asDict().output_files, null);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("the line budget is shared by stdout and stderr and keeps recent output", async () => {
  await fixture(async (directory) => {
    const result = await runBash("printf 'a\nb\nc'; printf 'd\ne\nf' >&2", {
      cwd: directory, timeout: 5, maxOutputLines: 4, outputDirectory: join(directory, "logs"),
    });
    assert.equal(result.stdout, "b\nc");
    assert.equal(result.stderr, "e\nf");
    assert.equal(result.truncated, true);
    const files = result.asDict().output_files as { stdout: string; stderr: string };
    assert.equal(await readFile(files.stdout, "utf8"), "a\nb\nc");
    assert.equal(await readFile(files.stderr, "utf8"), "d\ne\nf");
  });
});

test("snapshot publication rejection fails the tool and cleans up a running command", async () => {
  await fixture(async (directory) => {
    const result = await runBash("printf ready; sleep 10; printf should-not-run", {
      cwd: directory, timeout: 5,
      context: new ToolExecutionContext({ eventSink: async (kind) => {
        if (kind === "tool.output_snapshot") throw new Error("projection unavailable");
      } }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /projection unavailable/);
    assert.ok(!result.stdout.includes("should-not-run"));
    assert.ok(result.durationMs < 4500);
  });
});

test("file creation failure preserves the preview and reports incomplete archival", async () => {
  await fixture(async (directory) => {
    await writeFile(join(directory, "not-a-directory"), "occupied");
    const result = await runBash("printf abcdef", {
      cwd: directory, timeout: 5, maxOutputBytes: 3, outputDirectory: join(directory, "not-a-directory"),
    });
    assert.equal(result.stdout, "def");
    assert.equal(result.truncated, true);
    assert.equal(result.asDict().output_file_complete, false);
    assert.match(String(result.asDict().output_file_error), /output/i);
  });
});

test("snapshot consumers replace previews and recover the final output without prior snapshots", () => {
  const ui = new TerminalUI({ output: () => {} });
  ui.applyProjectedEvent(event("tool.started", { name: "bash", arguments: {} }));
  ui.applyProjectedEvent(event("tool.output_snapshot", { stream: "stdout", text: "A\nB" }));
  ui.applyProjectedEvent(event("tool.output_snapshot", { stream: "stdout", text: "B\nC" }));
  assert.equal(ui.state.activeTools.get("call-1")?.stdout, "B\nC");
  const block = ui.blockFor("tool", "call-1");
  assert.equal(block.kind === "tool" ? block.stdout : null, "B\nC");
  ui.applyProjectedEvent(event("tool.finished", { status: "completed", stdout: "C\nD", stderr: "warning" }));
  assert.equal(block.kind === "tool" ? block.stdout : null, "C\nD");
  assert.equal(block.kind === "tool" ? block.stderr : null, "warning");
  assert.equal(ui.state.activeTools.size, 0);
});

test("plain output prints the final preview once instead of repeating snapshots", () => {
  const lines: string[] = [];
  const sink = new PlainEventSink((text) => lines.push(text));
  sink.publishEvent(event("tool.started", { name: "bash", arguments: {} }));
  sink.publishEvent(event("tool.output_snapshot", { stream: "stderr", text: "A" }));
  sink.publishEvent(event("tool.output_snapshot", { stream: "stderr", text: "A B" }));
  assert.equal(lines.length, 1);
  sink.publishEvent(event("tool.finished", { status: "completed", stdout: "done", stderr: "A B" }));
  assert.equal(lines.filter((line) => line.includes("A B")).length, 1);
  assert.ok(lines.some((line) => line.includes("done")));
});

test("slow subscribers retain the latest snapshot for each stream without concatenation", async () => {
  const bus = new EventBus({ subscriber_mailbox_size: 65 });
  const received: { kind: string; payload: Record<string, unknown> }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  bus.subscribe(async (item) => {
    if (item.kind === "tool.started") await gate;
    received.push(item);
  });
  const metadata = { source: "tool", session_id: "session", task_id: "task", correlation_id: "call" };
  try {
    bus.publish("tool.started", { ...metadata, payload: { name: "bash", arguments: {} } });
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 100; i++) {
      for (const stream of ["stdout", "stderr"]) {
        bus.publish("tool.output_snapshot", { ...metadata, payload: { stream, text: `${stream}-${i}` } });
      }
    }
    bus.publish("tool.finished", { ...metadata, payload: { status: "completed" } });
    release();
    await bus.flush();
    assert.deepEqual(received.filter((item) => item.kind === "tool.output_snapshot").map((item) => item.payload.text), ["stdout-99", "stderr-99"]);
    assert.equal(received.at(-1)?.kind, "tool.finished");
  } finally { release(); await bus.close(); }
});

test("JSON escaping does not reject a valid 50KiB final tool result", () => {
  const factory = new EventFactory();
  const stdout = '"'.repeat(50 * 1024);
  const options = { source: "tool", session_id: "s", task_id: "t", correlation_id: "c" };
  assert.equal(factory.create("tool.output_snapshot", { ...options, payload: { stream: "stdout", text: stdout } }).payload.text, stdout);
  assert.equal(factory.create("tool.finished", { ...options, payload: { status: "completed", stdout } }).payload.stdout, stdout);
  assert.throws(() => factory.create("tool.output_snapshot", { ...options, payload: { stream: "stdout" } }), /missing payload fields/);
});

test("cropped credential fragments cannot enter terminal or log projections", () => {
  const factory = new EventFactory();
  const projector = new EventProjector();
  const ui = new TerminalUI({ output: () => {} });
  ui.applyProjectedEvent(event("tool.started", { name: "bash", arguments: {} }));
  const metadata = { source: "tool", session_id: "s", task_id: "t", correlation_id: "call-1" };
  for (const item of [
    factory.create("tool.output_snapshot", { ...metadata, payload: { stream: "stdout", text: "credential-tail\nprogress", start_mid_line: true } }),
    factory.create("tool.finished", { ...metadata, payload: { status: "completed", stdout: "credential-tail\nprogress", stdout_start_mid_line: true } }),
  ]) {
    assert.doesNotMatch(JSON.stringify(projector.project(item, "log")), /credential-tail/);
    ui.applyProjectedEvent(item);
  }
  const block = ui.blockFor("tool", "call-1");
  assert.ok(block.kind === "tool" && block.stdout.includes("progress"));
  assert.doesNotMatch(JSON.stringify(block), /credential-tail/);
});

test("repeated snapshots redact credentials without treating old text as a new delta", () => {
  const ui = new TerminalUI({ output: () => {} });
  ui.applyProjectedEvent(event("tool.started", { name: "bash", arguments: {} }));
  for (const text of ["token=first", "token=firstsecond\nOK"]) {
    ui.applyProjectedEvent(event("tool.output_snapshot", { stream: "stdout", text }));
  }
  assert.equal(ui.state.activeTools.get("call-1")?.stdout, "token=[REDACTED]\nOK");
});

test("archive limits are explicit and do not stop subsequent preview updates", async () => {
  await fixture(async (directory) => {
    const result = await runBash("printf abcdefghijklmnop; printf XYZ >&2", {
      cwd: directory, timeout: 5, maxOutputBytes: 4, maxOutputFileBytes: 8, outputDirectory: directory,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.asDict().output_file_complete, false);
    assert.match(String(result.asDict().output_file_error), /limit reached/);
    assert.ok(result.stdout.endsWith("p"));
    assert.ok(result.stderr.endsWith("Z"));
    const files = result.asDict().output_files as { stdout: string; stderr: string };
    assert.ok((await stat(files.stdout)).size + (await stat(files.stderr)).size <= 8);
  });
});

test("expired closed output is cleaned up while active output remains", async () => {
  await fixture(async (directory) => {
    for (const name of ["bash-old", "bash-active"]) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "stdout.log"), "preserve if active");
    }
    const completed = join(directory, "bash-old", "completed");
    await writeFile(completed, "");
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(completed, past, past);
    const result = await runBash("printf abcdef", { cwd: directory, timeout: 5, maxOutputBytes: 3, outputDirectory: directory });
    assert.equal(result.outputFileComplete, true);
    const names = await readdir(directory);
    assert.equal(names.includes("bash-old"), false);
    assert.equal(names.includes("bash-active"), true);
  });
});

for (const kind of ["tool.started", "tool.finished"]) {
  test(`asynchronous ${kind} failure is returned as a tool error`, async () => {
    const result = await runBash("printf done", {
      cwd: process.cwd(), timeout: 5,
      context: new ToolExecutionContext({ eventSink: async (published) => {
        if (published === kind) throw new Error("event unavailable");
      } }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /event unavailable/);
  });
}

test("agent-to-Bash context forwards rejected publication and commits the failed result", async () => {
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = {
    name: "offline",
    async runAttempt(request): Promise<ModelResult> {
      requests.push(request);
      return {
        requestId: request.requestId ?? "request", finishReason: requests.length === 1 ? "tool-calls" : "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        message: { role: "assistant", provider: "offline", model: "offline", content: requests.length === 1
          ? [{ type: "tool-call", call: { id: "bash-call", name: "bash", arguments: JSON.stringify({ command: "printf ready; sleep 10", description: "local fixture" }) } }]
          : [{ type: "text", text: "handled" }],
        },
      };
    },
  };
  const agent = new CodingAgent({ provider: "offline", model: "offline", modelAdapter: adapter,
    tools: new ToolRegistry([createBashToolDefinition({ projectRoot: process.cwd(), bashTimeoutSeconds: 5 })]),
  });
  assert.equal(await agent.run("run local fixture", {
    sessionId: "s", taskId: "t",
    async publish(kind) { if (kind === "tool.output_snapshot") throw new Error("session publication rejected"); },
  }), "handled");
  const message = agent.messages.find((item) => item.role === "tool-result");
  assert.ok(message?.role === "tool-result");
  assert.equal(message.isError, true);
  assert.match(message.content, /session publication rejected/);
});

test("slow output persistence cannot discard buffered pipe data after shell exit", async (t) => {
  await fixture(async (directory) => {
    const originalAppend = BashOutput.prototype.append;
    t.mock.method(BashOutput.prototype, "append", async function (this: BashOutput, stream, text) {
      if (text) await new Promise((resolve) => setTimeout(resolve, 180));
      await originalAppend.call(this, stream, text);
    });
    const original = "x".repeat(180_000) + "LAST";
    await writeFile(join(directory, "input"), original);
    const result = await runBash("cat input", {
      cwd: directory, timeout: 5, maxOutputBytes: 100, outputDirectory: join(directory, "logs"),
    });
    assert.equal(result.outputComplete, true);
    assert.equal(result.outputFileComplete, true);
    assert.equal(await readFile(result.outputFiles!.stdout, "utf8"), original);
  });
});

for (const [name, text, truncated] of [
  ["exact byte limit", "x".repeat(50 * 1024), false],
  ["one byte beyond", "x".repeat(50 * 1024 + 1), true],
  ["exact line limit", "row\n".repeat(1999) + "row", false],
  ["one line beyond", "row\n".repeat(2000) + "row", true],
] as const) {
  test(`default output budget: ${name}`, async () => {
    await fixture(async (directory) => {
      await writeFile(join(directory, "input"), text);
      const result = await runBash("cat input", { cwd: directory, timeout: 5, outputDirectory: join(directory, "logs") });
      assert.equal(result.truncated, truncated);
      assert.ok(Buffer.byteLength(result.stdout) <= 50 * 1024);
      assert.ok(result.stdout.split("\n").length <= 2000);
      if (!truncated) {
        assert.equal(result.stdout, text);
        assert.equal(result.outputFiles, null);
      } else {
        assert.equal(await readFile(result.outputFiles!.stdout, "utf8"), text);
      }
    });
  });
}

test("a slow event publisher receives latest snapshots without an in-flight backlog", async () => {
  await fixture(async (directory) => {
    let active = 0;
    let maximumActive = 0;
    const snapshots: string[] = [];
    const result = await runBash("for ((i=0;i<40;i++)); do printf '%s\\n' \"$i\"; sleep 0.01; done", {
      cwd: directory, timeout: 5, maxOutputBytes: 40, outputDirectory: join(directory, "logs"),
      context: new ToolExecutionContext({ eventSink: async (kind, payload) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (kind === "tool.output_snapshot") {
            await new Promise((resolve) => setTimeout(resolve, 180));
            if (payload.stream === "stdout") snapshots.push(String(payload.text));
          }
        } finally { active--; }
      } }),
    });
    assert.equal(result.status, "completed");
    assert.equal(maximumActive, 1);
    assert.ok(snapshots.length >= 2 && snapshots.length < 8);
    assert.ok(snapshots.at(-1)?.endsWith("39\n"));
    assert.equal(snapshots.at(-1), result.stdout);
  });
});

test("the interactive queue replaces pending snapshots and renders the latest progress", () => {
  const ui = new TerminalUI({ driver: {
    write: () => {}, flush: () => {}, restore: () => {}, getSize: () => ({ columns: 80, rows: 24 }),
  } });
  try {
    ui.startLoop(() => {});
    ui.publishEvent(event("tool.started", { name: "bash", arguments: {} }));
    for (let index = 0; index < 5000; index++) {
      ui.publishEvent(event("tool.output_snapshot", { stream: "stdout", text: `progress ${index}` }));
    }
    ui.drainLoop();
    const block = ui.blockFor("tool", "call-1");
    assert.ok(block.kind === "tool");
    assert.equal(block.stdout, "progress 4999");
    ui.applyDisplayAction({ type: "toggle_tool_output", expanded: true });
    const visible = ui.buildHistoryLines(80).join("\n");
    assert.match(visible, /progress 4999/);
    assert.doesNotMatch(visible, /省略了 .*流式展示事件/);
  } finally { ui.close(); }
});
