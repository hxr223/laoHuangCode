import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/** The observable outcome of a clipboard request. */
export type CopyResult =
  | { readonly status: "copied" }
  | { readonly status: "sent-to-terminal" }
  | { readonly status: "unavailable"; readonly reason: string };

/** Host capabilities used by copyText; callers can inject them without global state. */
export interface ClipboardOptions {
  readonly platform: NodeJS.Platform;
  readonly environ: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
  readonly writeTerminal: (sequence: string) => void;
  readonly run: (
    command: string,
    args: readonly string[],
    text: string,
  ) => Promise<{ readonly code: number; readonly stderr: string }>;
}

const POWERSHELL_SCRIPT =
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  "$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text";
const OSC52_TEXT_LIMIT_BYTES = 100 * 1024;
const STDERR_CAPTURE_LIMIT = 65_536;
const USER_DIAGNOSTIC_LIMIT = 600;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function safeDiagnostic(value: unknown): string {
  return errorMessage(value)
    .slice(0, USER_DIAGNOSTIC_LIMIT * 4)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, USER_DIAGNOSTIC_LIMIT);
}

/**
 * Creates the production clipboard subprocess runner.
 *
 * It launches a fixed command directly, writes text only to UTF-8 stdin, and
 * converts spawn, stdin, exit, and timeout failures into ordinary results.
 */
export function createClipboardRunner(
  environ: NodeJS.ProcessEnv,
  timeoutMs = 5000,
): ClipboardOptions["run"] {
  const env = { ...environ };
  return (command, args, text) => new Promise((resolve) => {
    let child: ChildProcessByStdio<Writable, null, Readable>;
    try {
      child = spawn(command, [...args], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (error) {
      resolve({ code: 1, stderr: errorMessage(error) });
      return;
    }

    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number, diagnostic = stderr): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stderr: diagnostic });
    };
    const stop = (diagnostic: string): void => {
      try { child.stdin.destroy(); } catch { /* The process may already be closed. */ }
      try { child.kill("SIGKILL"); } catch { /* Failure is already reported to the caller. */ }
      finish(1, diagnostic);
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAPTURE_LIMIT) {
        stderr += chunk.slice(0, STDERR_CAPTURE_LIMIT - stderr.length);
      }
    });
    child.stdin.on("error", (error) => stop(`clipboard command stdin failed: ${errorMessage(error)}`));
    child.once("error", (error) => stop(`clipboard command failed: ${errorMessage(error)}`));
    child.once("close", (code) => finish(code ?? 1));
    timer = setTimeout(() => stop(`clipboard command timed out after ${timeoutMs} ms`), timeoutMs);

    try {
      child.stdin.end(text, "utf8");
    } catch (error) {
      stop(`clipboard command stdin failed: ${errorMessage(error)}`);
    }
  });
}

function nativeCandidates(options: ClipboardOptions): readonly {
  readonly command: string;
  readonly args: readonly string[];
}[] {
  if (options.platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (options.platform === "win32") {
    return [{
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT],
    }];
  }
  if (options.platform !== "linux") return [];

  const candidates: { command: string; args: readonly string[] }[] = [];
  if (options.environ.WAYLAND_DISPLAY !== undefined) candidates.push({ command: "wl-copy", args: [] });
  if (options.environ.DISPLAY !== undefined) {
    candidates.push(
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    );
  }
  return candidates;
}

function terminalCopy(
  text: string,
  options: ClipboardOptions,
  nativeFailures: readonly string[],
): CopyResult {
  const unavailable = (reason: string): CopyResult => ({
    status: "unavailable",
    reason: nativeFailures.length > 0 ? `${nativeFailures.join("; ")}; ${reason}` : reason,
  });

  if (!options.isTTY) return unavailable("OSC 52 requires a TTY");
  if (!options.environ.TERM) return unavailable("OSC 52 requires TERM to identify a supported terminal");
  if (options.environ.TERM.toLowerCase() === "dumb") return unavailable("OSC 52 is unavailable when TERM is dumb");
  if (options.environ.STY !== undefined || (/^screen(?:-|$)/.test(options.environ.TERM) && options.environ.TMUX === undefined)) {
    return unavailable("GNU screen OSC 52 passthrough is unsupported");
  }
  if (Buffer.byteLength(text, "utf8") > OSC52_TEXT_LIMIT_BYTES) {
    return unavailable("OSC 52 text exceeds the 100 KiB UTF-8 limit");
  }

  const osc = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  const sequence = options.environ.TMUX
    ? `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
    : osc;
  try {
    options.writeTerminal(sequence);
    return { status: "sent-to-terminal" };
  } catch (error) {
    return unavailable(`OSC 52 terminal write failed: ${safeDiagnostic(error)}`);
  }
}

/** Copy text through a local native backend or one OSC 52 terminal request. */
export async function copyText(text: string, options: ClipboardOptions): Promise<CopyResult> {
  const isSSH = options.environ.SSH_CONNECTION !== undefined || options.environ.SSH_TTY !== undefined;
  const failures: string[] = [];
  if (!isSSH) {
    for (const candidate of nativeCandidates(options)) {
      try {
        const result = await options.run(candidate.command, candidate.args, text);
        if (result.code === 0) return { status: "copied" };
        const diagnostic = safeDiagnostic(result.stderr);
        failures.push(`${candidate.command} failed with code ${result.code}${diagnostic ? `: ${diagnostic}` : ""}`);
      } catch (error) {
        failures.push(`${candidate.command} failed: ${safeDiagnostic(error)}`);
      }
    }
  }
  return terminalCopy(text, options, failures);
}
