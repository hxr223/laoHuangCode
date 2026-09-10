import { spawn } from "node:child_process";
export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}
export function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
    signal?: AbortSignal;
    maxBytes?: number;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now(),
      detached = process.platform !== "win32";
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached,
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      cancelled = false,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const max = options.maxBytes ?? 2 * 1024 * 1024;
    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const stop = (): void => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 500);
    };
    const abort = (): void => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout = (stdout + data).slice(-max);
    });
    child.stderr.on("data", (data: string) => {
      stderr = (stderr + data).slice(-max);
    });
    child.stdin.on("error", () => {});
    const cleanup = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        cancelled,
        durationMs: Date.now() - start,
      });
    });
    child.stdin.end(options.input ?? "");
    if (options.signal?.aborted) abort();
  });
}
