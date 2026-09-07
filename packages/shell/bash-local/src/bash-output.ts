import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type OutputStream = "stdout" | "stderr";
export const BASH_OUTPUT_MAX_BYTES = 50 * 1024;
export const BASH_OUTPUT_MAX_LINES = 2000;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OUTPUT_FILE_MAX_BYTES = 64 * 1024 * 1024;

export interface BashOutputOptions {
  maxOutputBytes?: number;
  maxOutputLines?: number;
  outputDirectory?: string;
  maxOutputFileBytes?: number;
}

interface Tail {
  text: string;
  startMidLine: boolean;
}

function lines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** Crop at UTF-8 boundaries; mark fragments whose credential prefix may be lost. */
function tail(value: Tail, maxBytes: number, maxLines: number): Tail {
  if (maxBytes <= 0 || maxLines <= 0) return { text: "", startMidLine: value.text !== "" || value.startMidLine };
  const bytes = Buffer.from(value.text);
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  let text = bytes.subarray(start).toString("utf8");
  let startMidLine = start > 0 ? bytes[start - 1] !== 0x0a : value.startMidLine;
  const parts = text.split("\n");
  if (parts.length > maxLines) {
    text = parts.slice(-maxLines).join("\n");
    startMidLine = false;
  }
  return { text, startMidLine };
}

/** One command's bounded preview and optional, private overflow files. */
export class BashOutput {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly #directory: string;
  readonly #fileLimit: number;
  readonly #tails: Record<OutputStream, Tail> = {
    stdout: { text: "", startMidLine: false },
    stderr: { text: "", startMidLine: false },
  };
  readonly #totals: Record<OutputStream, number> = { stdout: 0, stderr: 0 };
  readonly #handles: Partial<Record<OutputStream, FileHandle>> = {};
  #pending = Promise.resolve();
  #archiveDirectory: string | null = null;
  #fileBytes = 0;
  #spillAttempted = false;
  files: Record<OutputStream, string> | null = null;
  fileError: string | null = null;
  revision = 0;

  constructor(options: BashOutputOptions = {}) {
    this.maxBytes = options.maxOutputBytes ?? BASH_OUTPUT_MAX_BYTES;
    this.maxLines = options.maxOutputLines ?? BASH_OUTPUT_MAX_LINES;
    this.#fileLimit = options.maxOutputFileBytes ?? OUTPUT_FILE_MAX_BYTES;
    for (const limit of [this.maxBytes, this.maxLines, this.#fileLimit]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Bash output limits must be positive integers");
    }
    this.#directory = resolve(options.outputDirectory ?? join(homedir(), ".laohuang", "tool-output"));
  }

  append(stream: OutputStream, text: string): Promise<void> {
    // At most one read per pipe waits here. File backpressure cannot build an
    // unbounded promise/chunk queue, and stdout/stderr cannot race the spill.
    const next = this.#pending.then(() => this.#append(stream, text));
    this.#pending = next.catch(() => {});
    return next;
  }

  async #append(stream: OutputStream, text: string): Promise<void> {
    if (!text) return;
    const combined = { ...this.#tails[stream], text: this.#tails[stream].text + text };
    const other = stream === "stdout" ? "stderr" : "stdout";
    if (!this.#spillAttempted && (
      Buffer.byteLength(combined.text) + Buffer.byteLength(this.#tails[other].text) > this.maxBytes ||
      lines(combined.text) + lines(this.#tails[other].text) > this.maxLines
    )) {
      this.#spillAttempted = true;
      await this.#startArchive();
      for (const name of ["stdout", "stderr"] as const) await this.#write(name, this.#tails[name].text);
    }
    await this.#write(stream, text);
    this.#totals[stream] += Buffer.byteLength(text);
    this.#tails[stream] = tail(combined, this.maxBytes, this.maxLines);
    this.revision++;
  }

  snapshot(): Record<OutputStream, Tail & { truncated: boolean }> {
    // Reserve up to half for stderr, give unused space to stdout, then return
    // any remaining stdout allowance to stderr. Both dimensions are shared.
    const reserved = tail(this.#tails.stderr, Math.floor(this.maxBytes / 2), Math.floor(this.maxLines / 2));
    const stdout = tail(this.#tails.stdout, this.maxBytes - Buffer.byteLength(reserved.text), this.maxLines - lines(reserved.text));
    const stderr = tail(this.#tails.stderr, this.maxBytes - Buffer.byteLength(stdout.text), this.maxLines - lines(stdout.text));
    return {
      stdout: { ...stdout, truncated: Buffer.byteLength(stdout.text) < this.#totals.stdout },
      stderr: { ...stderr, truncated: Buffer.byteLength(stderr.text) < this.#totals.stderr },
    };
  }

  async #startArchive(): Promise<void> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await this.#removeExpired();
      this.#archiveDirectory = await mkdtemp(join(this.#directory, "bash-"));
      const files = {
        stdout: join(this.#archiveDirectory, "stdout.log"),
        stderr: join(this.#archiveDirectory, "stderr.log"),
      };
      for (const stream of ["stdout", "stderr"] as const) this.#handles[stream] = await open(files[stream], "wx", 0o600);
      this.files = files;
    } catch (error) {
      this.fileError = `Cannot save Bash output: ${String(error)}`;
    }
  }

  async #write(stream: OutputStream, text: string): Promise<void> {
    const handle = this.#handles[stream];
    if (!handle || this.fileError !== null || text === "") return;
    try {
      const bytes = Buffer.from(text);
      const available = Math.max(0, this.#fileLimit - this.#fileBytes);
      let end = Math.min(bytes.length, available);
      while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      if (end > 0) await handle.writeFile(bytes.subarray(0, end));
      this.#fileBytes += end;
      if (end < bytes.length) this.fileError = `Bash output file limit reached (${this.#fileLimit} bytes); files contain partial output`;
    } catch (error) {
      this.fileError = `Cannot save Bash output: ${String(error)}`;
    }
  }

  async close(): Promise<void> {
    await this.#pending;
    for (const handle of Object.values(this.#handles)) {
      try { await handle.close(); } catch (error) { this.fileError ??= `Cannot close Bash output: ${String(error)}`; }
    }
    if (this.#archiveDirectory !== null) {
      try { await writeFile(join(this.#archiveDirectory, "completed"), "", { mode: 0o600 }); } catch { /* Retain files if retention bookkeeping fails. */ }
    }
  }

  async #removeExpired(): Promise<void> {
    // Only closed archives have this marker; never remove a running command's files.
    for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("bash-")) continue;
      const directory = join(this.#directory, entry.name);
      try {
        if (Date.now() - (await stat(join(directory, "completed"))).mtimeMs > OUTPUT_RETENTION_MS) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch { /* Active archives and concurrent cleanup are harmless. */ }
    }
  }
}
