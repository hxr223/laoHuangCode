/**
 * Streaming, cancellable execution for the Bash tool.
 *
 * The runner deliberately owns process lifecycle and pipe draining, while
 * callers decide how emitted events are presented. It targets macOS and
 * Linux, where a detached child becomes a process-group leader so that
 * cancellation can terminate the whole command process group.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";

import {
  ToolExecutionContext,
  type ToolEventPublisher,
  type ToolEventSink,
  type ToolExecutionContextInit,
} from "@laohuang/tools";

export type BashStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_failed";

type StreamName = "stdout" | "stderr";

const FLUSH_INTERVAL_MS = 40;
const FLUSH_CHARS = 4096;
const TERMINATION_GRACE_MS = 2000;
const WATCHDOG_INTERVAL_MS = 10;

export const MODEL_API_KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "LAOHUANG_API_KEY",
] as const;

export {
  ToolExecutionContext,
  type ToolEventPublisher,
  type ToolEventSink,
  type ToolExecutionContextInit,
};

export interface BashResultInit {
  status: BashStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: string | null;
  durationMs?: number;
  truncated?: boolean;
}

export class BashResult {
  status: BashStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  durationMs: number;
  truncated: boolean;

  constructor(init: BashResultInit) {
    this.status = init.status;
    this.stdout = init.stdout ?? "";
    this.stderr = init.stderr ?? "";
    this.exitCode = init.exitCode ?? null;
    this.error = init.error ?? null;
    this.durationMs = init.durationMs ?? 0;
    this.truncated = init.truncated ?? false;
  }

  get ok(): boolean {
    return this.status === "completed" && this.exitCode === 0;
  }

  asDict(): Record<string, unknown> {
    const result: Record<string, unknown> = {
      ok: this.ok,
      status: this.status,
      exit_code: this.exitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      duration_ms: this.durationMs,
      truncated: this.truncated,
    };
    if (this.error) {
      result["error"] = this.error;
    }
    return result;
  }
}

/** Keep a 40% head and 60% tail without retaining unbounded output. */
class BoundedOutput {
  readonly limit: number;
  readonly headLimit: number;
  readonly tailLimit: number;
  totalChars = 0;
  private whole = "";
  private head = "";
  private tail = "";
  private isTruncated = false;

  constructor(limit: number) {
    this.limit = Math.max(0, Math.trunc(limit));
    this.headLimit = Math.trunc(this.limit * 0.4);
    this.tailLimit = this.limit - this.headLimit;
  }

  append(text: string): void {
    if (!text) return;
    this.totalChars += text.length;
    if (this.limit === 0) {
      this.isTruncated = true;
      return;
    }

    if (!this.isTruncated && this.whole.length + text.length <= this.limit) {
      this.whole += text;
      return;
    }

    if (!this.isTruncated) {
      const combined = this.whole + text;
      this.head = combined.slice(0, this.headLimit);
      this.tail = this.tailLimit > 0 ? combined.slice(-this.tailLimit) : "";
      this.whole = "";
      this.isTruncated = true;
      return;
    }

    if (this.tailLimit > 0) {
      this.tail = (this.tail + text).slice(-this.tailLimit);
    }
  }

  render(): string {
    if (!this.isTruncated) return this.whole;
    const retained = this.head.length + this.tail.length;
    const omitted = Math.max(0, this.totalChars - retained);
    const marker = `\n...[truncated ${omitted} chars]...\n`;
    return this.head + marker + this.tail;
  }

  get truncated(): boolean {
    return this.isTruncated;
  }
}

type SanitizerState =
  | "normal"
  | "escape"
  | "csi"
  | "osc"
  | "string"
  | "stringEscape";

/** Incrementally remove terminal control sequences from untrusted output. */
class TerminalSanitizer {
  private state: SanitizerState = "normal";

  feed(text: string): string {
    let safe = "";
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (this.state === "normal") {
        if (character === "\x1b") {
          this.state = "escape";
        } else if (character === "\r") {
          safe += "\n";
        } else if (character === "\n" || character === "\t" || code >= 0x20) {
          if (code !== 0x7f) safe += character;
        }
        continue;
      }

      if (this.state === "escape") {
        if (character === "[") {
          this.state = "csi";
        } else if (
          character === "P" ||
          character === "X" ||
          character === "^" ||
          character === "_"
        ) {
          this.state = "string";
        } else if (character === "]") {
          this.state = "osc";
        } else {
          this.state = "normal";
        }
        continue;
      }

      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "normal";
        continue;
      }

      if (this.state === "osc" || this.state === "string") {
        if (character === "\x07") {
          this.state = "normal";
        } else if (character === "\x1b") {
          this.state = "stringEscape";
        }
        continue;
      }

      if (this.state === "stringEscape") {
        if (character === "\\") {
          this.state = "normal";
        } else if (character !== "\x1b") {
          this.state = "string";
        }
      }
    }
    return safe;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * SIGTERM the whole process group, escalating to SIGKILL after a grace
 * period. Falls back to signalling only the leader when group signalling
 * is not possible.
 */
async function terminateProcessGroup(
  child: ChildProcess,
  graceMs: number = TERMINATION_GRACE_MS,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The leader may already be gone; the liveness loop below handles it.
    }
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ESRCH") return;
      if (code === "EPERM") break;
    }
    await sleep(20);
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (errnoCode(error) === "ESRCH") return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Nothing left to kill.
    }
  }
}

function cleanEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const cleaned = { ...environment };
  for (const name of MODEL_API_KEY_ENV_NAMES) {
    delete cleaned[name];
  }
  return cleaned;
}

function toExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
): number | null {
  if (code !== null) return code;
  if (!signal) return null;
  const signalNumber: number | undefined = osConstants.signals[signal];
  return typeof signalNumber === "number" ? -signalNumber : null;
}

export interface RunBashOptions {
  cwd: string;
  /** Seconds; a negative value disables the timeout. */
  timeout: number;
  maxOutputChars: number;
  context?: ToolExecutionContext | null;
  env?: Record<string, string | undefined> | null;
}

/** Run one non-interactive Bash command and emit sanitized output deltas. */
export async function runBash(
  command: string,
  options: RunBashOptions,
): Promise<BashResult> {
  const invokedAt = performance.now();
  const execution = options.context ?? new ToolExecutionContext();

  if (execution.isCancelled()) {
    const result = new BashResult({
      status: "cancelled",
      error: execution.cancellationReason,
      durationMs: Math.trunc(performance.now() - invokedAt),
    });
    execution.publish("tool.finished", result.asDict());
    return result;
  }

  const environment = cleanEnvironment(options.env ?? process.env);
  const child = spawn("/bin/bash", ["-lc", command], {
    cwd: options.cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (error) => resolve(error));
  });
  if (spawnError) {
    const result = new BashResult({
      status: "spawn_failed",
      error: String(spawnError),
      durationMs: Math.trunc(performance.now() - invokedAt),
    });
    execution.publish("tool.finished", result.asDict());
    return result;
  }
  // Later asynchronous kill failures must not surface as unhandled errors.
  child.on("error", () => {});

  execution.publish("tool.started", {
    name: "bash",
    arguments: { command },
  });

  const outputs: Record<StreamName, BoundedOutput> = {
    stdout: new BoundedOutput(options.maxOutputChars),
    stderr: new BoundedOutput(options.maxOutputChars),
  };
  const pending: Record<StreamName, string> = { stdout: "", stderr: "" };
  const streamSequence: Record<StreamName, number> = { stdout: 0, stderr: 0 };

  const flush = (stream: StreamName): void => {
    const text = pending[stream];
    if (!text) return;
    pending[stream] = "";
    outputs[stream].append(text);
    streamSequence[stream] += 1;
    execution.publish("tool.output_delta", {
      name: "bash",
      stream,
      text,
      stream_sequence: streamSequence[stream],
    });
  };

  const readPipe = async (
    stream: StreamName,
    pipe: NodeJS.ReadableStream,
  ): Promise<void> => {
    const decoder = new StringDecoder("utf8");
    const sanitizer = new TerminalSanitizer();
    const ingest = (text: string): void => {
      if (!text) return;
      pending[stream] += text;
      if (pending[stream].length >= FLUSH_CHARS) flush(stream);
    };
    try {
      for await (const chunk of pipe) {
        ingest(sanitizer.feed(decoder.write(chunk as Buffer)));
      }
      ingest(sanitizer.feed(decoder.end()));
    } catch {
      // Pipes can be torn down by cancellation cleanup while readers are active.
    }
  };

  const stdoutDone = readPipe("stdout", child.stdout!);
  const stderrDone = readPipe("stderr", child.stderr!);
  const exitInfo = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let terminalStatus: BashStatus | null = null;
  const startedAt = performance.now();
  let lastFlush = startedAt;
  const timeoutMs = options.timeout * 1000;

  const watchdog = setInterval(() => {
    const now = performance.now();
    if (terminalStatus === null) {
      if (execution.isCancelled()) {
        terminalStatus = "cancelled";
        void terminateProcessGroup(child);
      } else if (options.timeout >= 0 && now - startedAt >= timeoutMs) {
        terminalStatus = "timed_out";
        void terminateProcessGroup(child);
      }
    }
    if (now - lastFlush >= FLUSH_INTERVAL_MS) {
      flush("stdout");
      flush("stderr");
      lastFlush = now;
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  try {
    await Promise.all([stdoutDone, stderrDone, exitInfo]);
  } finally {
    clearInterval(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      await terminateProcessGroup(child);
    }
  }
  flush("stdout");
  flush("stderr");

  const { code, signal } = await exitInfo;
  const exitCode = toExitCode(code, signal);
  const stdout = outputs.stdout.render();
  const stderr = outputs.stderr.render();
  const durationMs = Math.trunc(performance.now() - invokedAt);
  const truncated = outputs.stdout.truncated || outputs.stderr.truncated;

  let result: BashResult;
  if (terminalStatus === "cancelled") {
    result = new BashResult({
      status: "cancelled",
      stdout,
      stderr,
      exitCode,
      error: execution.cancellationReason,
      durationMs,
      truncated,
    });
  } else if (terminalStatus === "timed_out") {
    result = new BashResult({
      status: "timed_out",
      stdout,
      stderr,
      exitCode,
      error: `Bash command timed out after ${options.timeout} seconds`,
      durationMs,
      truncated,
    });
  } else if (exitCode === 0) {
    result = new BashResult({
      status: "completed",
      stdout,
      stderr,
      exitCode,
      durationMs,
      truncated,
    });
  } else {
    result = new BashResult({
      status: "failed",
      stdout,
      stderr,
      exitCode,
      error: `Bash command exited with code ${exitCode}`,
      durationMs,
      truncated,
    });
  }

  execution.publish("tool.finished", result.asDict());
  return result;
}
