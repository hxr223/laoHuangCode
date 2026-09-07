/**
 * Streaming, cancellable execution for the Bash tool.
 *
 * The runner deliberately owns process lifecycle and pipe draining, while
 * callers decide how emitted events are presented. Unix uses process-group
 * signals for cancellation; Windows uses taskkill to terminate the tree.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { CancelToken } from "@laohuang/runtime-protocol";
import { resolveBashPath } from "./bash-path.ts";
import { BashOutput, type BashOutputOptions } from "./bash-output.ts";

export type BashStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_failed";

type StreamName = "stdout" | "stderr";

const FLUSH_INTERVAL_MS = 100;
const TERMINATION_GRACE_MS = 2000;
const WATCHDOG_INTERVAL_MS = 10;
const POST_EXIT_IDLE_MS = 100;
const TERMINATION_EXIT_GRACE_MS = 1000;
const TASKKILL_TIMEOUT_MS = 5000;

export const MODEL_API_KEY_ENV_NAMES = [
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "LAOHUANG_API_KEY",
] as const;

/** Structural minimum for the CancelToken owned by runtime-protocol. */
export interface CancelTokenLike {
  isCancelled?: CancelToken["isCancelled"];
  isSet?: () => boolean;
  cancelled?: boolean;
  reason?: unknown;
}

/** Structural minimum for the EventBus owned by runtime-protocol. */
export interface ToolEventPublisher {
  publish(
    kind: string,
    options: {
      source: string;
      session_id: string;
      task_id: string | null;
      correlation_id: string | null;
      payload: Record<string, unknown>;
    },
  ): unknown;
}

export type ToolEventSink =
  | ToolEventPublisher
  | ((kind: string, payload: Record<string, unknown>) => unknown);

export interface ToolExecutionContextInit {
  sessionId?: string | null;
  taskId?: string | null;
  toolCallId?: string | null;
  cancelToken?: CancelTokenLike | null;
  eventSink?: ToolEventSink | null;
}

/** Runtime metadata and optional cooperative services for a bash command. */
export class ToolExecutionContext {
  sessionId: string | null;
  taskId: string | null;
  toolCallId: string | null;
  cancelToken: CancelTokenLike | null;
  eventSink: ToolEventSink | null;

  constructor(init: ToolExecutionContextInit = {}) {
    this.sessionId = init.sessionId ?? null;
    this.taskId = init.taskId ?? null;
    this.toolCallId = init.toolCallId ?? null;
    this.cancelToken = init.cancelToken ?? null;
    this.eventSink = init.eventSink ?? null;
  }

  isCancelled(): boolean {
    const token = this.cancelToken;
    if (token == null) return false;
    if (typeof token.isCancelled === "function") {
      return Boolean(token.isCancelled.call(token));
    }
    if (typeof token.isSet === "function") {
      return Boolean(token.isSet.call(token));
    }
    return Boolean(token.cancelled);
  }

  get cancellationReason(): string {
    const reason = this.cancelToken?.reason;
    return reason ? String(reason) : "cancelled";
  }

  /** Publish through an EventBus, with a tiny callback fallback for tests. */
  publish(kind: string, payload: Record<string, unknown>): unknown {
    const sink = this.eventSink;
    if (sink == null) return;

    if (typeof sink === "function") {
      return sink(kind, payload);
    }

    if (typeof sink.publish === "function") {
      return sink.publish(kind, {
        source: "tool",
        session_id: this.sessionId ?? "local",
        task_id: this.taskId,
        correlation_id: this.toolCallId,
        payload,
      });
    }
  }
}

export interface BashResultInit {
  status: BashStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  error?: string | null;
  durationMs?: number;
  truncated?: boolean;
  outputComplete?: boolean;
  outputFiles?: Record<StreamName, string> | null;
  outputFileComplete?: boolean;
  outputFileError?: string | null;
  stdoutStartMidLine?: boolean;
  stderrStartMidLine?: boolean;
}

export class BashResult {
  status: BashStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error: string | null;
  durationMs: number;
  truncated: boolean;
  outputComplete: boolean;
  outputFiles: Record<StreamName, string> | null;
  outputFileComplete: boolean;
  outputFileError: string | null;
  stdoutStartMidLine: boolean;
  stderrStartMidLine: boolean;

  constructor(init: BashResultInit) {
    this.status = init.status;
    this.stdout = init.stdout ?? "";
    this.stderr = init.stderr ?? "";
    this.exitCode = init.exitCode ?? null;
    this.error = init.error ?? null;
    this.durationMs = init.durationMs ?? 0;
    this.truncated = init.truncated ?? false;
    this.outputComplete = init.outputComplete ?? true;
    this.outputFiles = init.outputFiles ?? null;
    this.outputFileComplete = init.outputFileComplete ?? false;
    this.outputFileError = init.outputFileError ?? null;
    this.stdoutStartMidLine = init.stdoutStartMidLine ?? false;
    this.stderrStartMidLine = init.stderrStartMidLine ?? false;
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
      output_complete: this.outputComplete,
      output_files: this.outputFiles,
      output_file_complete: this.outputFileComplete,
      stdout_start_mid_line: this.stdoutStartMidLine,
      stderr_start_mid_line: this.stderrStartMidLine,
    };
    if (this.outputFileError) result["output_file_error"] = this.outputFileError;
    if (this.error) {
      result["error"] = this.error;
    }
    return result;
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
 * Terminate the Windows process tree, or signal the Unix process group with
 * SIGTERM and escalate to SIGKILL after a grace period.
 */
async function terminateProcessTree(
  child: ChildProcess,
  graceMs: number = TERMINATION_GRACE_MS,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    const taskkill = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await new Promise<void>((resolve, reject) => {
      execFile(taskkill, ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }, (error) => {
        if (error) reject(new Error(`taskkill failed: ${error.message}`));
        else resolve();
      });
    });
    return;
  }

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

export interface RunBashOptions extends BashOutputOptions {
  cwd: string;
  shellPath?: string | undefined;
  /** Seconds; a negative value disables the timeout. */
  timeout: number;
  context?: Pick<ToolExecutionContext, "isCancelled" | "cancellationReason" | "publish"> | null;
  env?: Record<string, string | undefined> | null;
}

/** Run one non-interactive Bash command and emit bounded output snapshots. */
export async function runBash(
  command: string,
  options: RunBashOptions,
): Promise<BashResult> {
  const invokedAt = performance.now();
  const execution = options.context ?? new ToolExecutionContext();
  const output = new BashOutput(options);
  let publicationError: string | null = null;
  const publish = async (kind: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await execution.publish(kind, payload);
    } catch (error) {
      publicationError ??= `Bash event publication failed: ${String(error)}`;
    }
  };
  const finish = async (result: BashResult): Promise<BashResult> => {
    await publish("tool.finished", result.asDict());
    if (publicationError !== null) {
      result.status = "failed";
      if (!result.error?.includes(publicationError)) {
        result.error = [result.error, publicationError].filter(Boolean).join("; ");
      }
    }
    return result;
  };

  if (execution.isCancelled()) {
    const result = new BashResult({
      status: "cancelled",
      error: execution.cancellationReason,
      durationMs: Math.trunc(performance.now() - invokedAt),
    });
    return await finish(result);
  }

  const environment = cleanEnvironment(options.env ?? process.env);
  let child: ChildProcess;
  try {
    const shellPath = resolveBashPath({ shellPath: options.shellPath, env: environment });
    child = spawn(shellPath, ["-lc", command], {
      cwd: options.cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
  } catch (error) {
    const result = new BashResult({
      status: "spawn_failed",
      error: String(error),
      durationMs: Math.trunc(performance.now() - invokedAt),
    });
    return await finish(result);
  }
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
    return await finish(result);
  }
  // Later asynchronous kill failures must not surface as unhandled errors.
  child.on("error", () => {});

  const started = publish("tool.started", { name: "bash", arguments: { command } });
  let publishing: Promise<void> | null = null;
  let publishedRevision = 0;
  let exited = false;
  let lastOutputAt = performance.now();
  let outputIncomplete = false;
  const ingesting: Record<StreamName, boolean> = { stdout: false, stderr: false };

  const closeOutput = (force = false): void => {
    for (const stream of ["stdout", "stderr"] as const) {
      const pipe = child[stream];
      // Waiting for disk is backpressure, not an idle inherited pipe. Finish
      // persisting the current read and draining Node's buffered bytes first.
      if (!force && (ingesting[stream] || (pipe?.readableLength ?? 0) > 0)) continue;
      if (pipe && !pipe.readableEnded && !pipe.destroyed) {
        outputIncomplete = true;
        pipe.destroy();
      }
    }
  };

  const flush = (): void => {
    if (publishing !== null || publicationError !== null || publishedRevision === output.revision) return;
    const snapshot = output.snapshot();
    publishedRevision = output.revision;
    const revision = publishedRevision;
    // Only one publication is in flight. Further reads update bounded state;
    // the next tick sends the latest state instead of queueing every revision.
    publishing = (async () => {
      await started;
      for (const stream of ["stdout", "stderr"] as const) {
        if (publicationError !== null) break;
        await publish("tool.output_snapshot", {
          name: "bash", stream, text: snapshot[stream].text,
          stream_sequence: revision, truncated: snapshot[stream].truncated,
          start_mid_line: snapshot[stream].startMidLine,
        });
      }
    })().finally(() => { publishing = null; });
  };

  const readPipe = async (
    stream: StreamName,
    pipe: NodeJS.ReadableStream,
  ): Promise<void> => {
    const decoder = new StringDecoder("utf8");
    const sanitizer = new TerminalSanitizer();
    try {
      for await (const chunk of pipe) {
        lastOutputAt = performance.now();
        ingesting[stream] = true;
        try {
          await output.append(stream, sanitizer.feed(decoder.write(chunk as Buffer)));
        } finally {
          ingesting[stream] = false;
          lastOutputAt = performance.now();
        }
      }
    } catch {
      // Cancellation can tear down a pipe; never claim its output is complete.
      outputIncomplete = true;
    } finally {
      await output.append(stream, sanitizer.feed(decoder.end()));
    }
  };

  const stdoutDone = readPipe("stdout", child.stdout!);
  const stderrDone = readPipe("stderr", child.stderr!);
  type ExitInfo = {
    code: number | null;
    signal: NodeJS.Signals | null;
  };
  let resolveExit!: (info: ExitInfo) => void;
  const exitInfo = new Promise<ExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exited = true;
    lastOutputAt = performance.now();
    resolveExit({ code, signal });
  };
  child.once("exit", onExit);

  let terminalStatus: BashStatus | null = null;
  const startedAt = performance.now();
  let lastFlush = startedAt;
  const timeoutMs = options.timeout * 1000;
  let termination: Promise<void> | null = null;
  let terminationCompletedAt: number | null = null;
  let cleanupError: string | null = null;
  const terminate = (): void => {
    if (termination !== null) return;
    termination = terminateProcessTree(child).catch((error: unknown) => {
      cleanupError = error instanceof Error ? error.message : String(error);
      // A leader-only fallback cannot confirm descendant cleanup, so keep the error.
      try { child.kill("SIGKILL"); } catch { /* Report the cleanup failure below. */ }
    }).finally(() => {
      terminationCompletedAt = performance.now();
    });
  };

  const watchdog = setInterval(() => {
    const now = performance.now();
    if (terminalStatus === null) {
      if (publicationError !== null) {
        terminalStatus = "failed";
        terminate();
      } else if (execution.isCancelled()) {
        terminalStatus = "cancelled";
        terminate();
      } else if (options.timeout >= 0 && now - startedAt >= timeoutMs) {
        terminalStatus = "timed_out";
        terminate();
      }
    }
    // Descendants can inherit pipes after the shell exits. Keep active output,
    // but release quiet handles rather than waiting indefinitely for EOF.
    if (exited && now - lastOutputAt >= POST_EXIT_IDLE_MS) closeOutput();
    if (terminationCompletedAt !== null && now - terminationCompletedAt >= TERMINATION_EXIT_GRACE_MS) {
      closeOutput(true);
      if (!exited) {
        cleanupError ??= "Bash did not exit after process termination";
        child.unref();
        resolveExit({ code: null, signal: null });
      }
    }
    if (now - lastFlush >= FLUSH_INTERVAL_MS) {
      flush();
      lastFlush = now;
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  try {
    await Promise.all([stdoutDone, stderrDone, exitInfo]);
  } finally {
    clearInterval(watchdog);
    child.removeListener("exit", onExit);
    await termination;
    await output.close();
  }
  await started;
  await publishing;
  flush();
  await publishing;

  const { code, signal } = await exitInfo;
  const exitCode = toExitCode(code, signal);
  const snapshot = output.snapshot();
  const stdout = snapshot.stdout.text;
  const stderr = snapshot.stderr.text;
  const durationMs = Math.trunc(performance.now() - invokedAt);
  const truncated = snapshot.stdout.truncated || snapshot.stderr.truncated;

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

  if (cleanupError !== null) {
    result.error = `${result.error ?? "Bash execution failed"}; Process cleanup failed: ${cleanupError}`;
  }
  result.outputComplete = !outputIncomplete;
  result.outputFiles = output.files;
  result.outputFileComplete = output.files !== null && output.fileError === null && !outputIncomplete;
  result.outputFileError = output.fileError;
  result.stdoutStartMidLine = snapshot.stdout.startMidLine;
  result.stderrStartMidLine = snapshot.stderr.startMidLine;
  if (publicationError !== null) {
    result.status = "failed";
    result.error = publicationError + (cleanupError === null ? "" : `; Process cleanup failed: ${cleanupError}`);
  }
  return await finish(result);
}
