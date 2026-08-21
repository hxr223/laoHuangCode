/** Tool definitions and execution for the coding agent. */

import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";

import { runBash as runBashCommand } from "./bash-runner.ts";
import type { ToolExecutionContext } from "./bash-runner.ts";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a UTF-8 text file inside the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create or fully overwrite a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace one exact, unique text occurrence in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." },
          old_text: { type: "string", description: "Exact text to replace." },
          new_text: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a Bash command in the project root.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

export type ToolExecutionMode = "parallel" | "sequential";

/** Plain-object result returned to the model for every tool call. */
export interface ToolResult {
  ok: boolean;
  status?: string;
  content?: string;
  path?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Minimal structural view of the execution context owned by bash-runner.ts.
 * Its ToolExecutionContext class satisfies this interface; cancellation.ts's
 * CancelToken backs `isCancelled` / `cancellationReason`.
 */
export interface ToolExecutionContextLike {
  isCancelled(): boolean;
  readonly cancellationReason: string;
  publish?(kind: string, payload: Record<string, unknown>): void;
}

export interface RunBashOptions {
  cwd: string;
  timeoutSeconds: number;
  maxOutputChars: number;
  context: ToolExecutionContextLike;
  env: Record<string, string | undefined>;
}

/**
 * Injectable bash runner contract. The default implementation calls
 * bash-runner.ts's `runBash`, translates the options, and returns its result
 * as a plain dict via BashResult.asDict().
 */
export type RunBash = (
  command: string,
  options: RunBashOptions,
) => Promise<ToolResult>;

/** Injectable file IO so tests can instrument reads/writes (mirrors the
 * Python tests patching Path.read_text / Path.write_text). */
export interface ToolFileIo {
  readFile(target: string): Promise<string>;
  writeFile(target: string, content: string): Promise<void>;
}

const DEFAULT_IO: ToolFileIo = {
  readFile: (target) => fs.readFile(target, "utf8"),
  writeFile: (target, content) => fs.writeFile(target, content, "utf8"),
};

const NOOP_CONTEXT: ToolExecutionContextLike = {
  isCancelled: () => false,
  cancellationReason: "cancelled",
  publish: () => {},
};

async function defaultRunBash(
  command: string,
  options: RunBashOptions,
): Promise<ToolResult> {
  // Only a context carrying the full publish() surface is safe to hand to
  // bash-runner; anything else (e.g. a bare test stub) is replaced so the
  // runner can fall back to its own default context.
  const context =
    typeof options.context.publish === "function" ? options.context : null;
  const result = await runBashCommand(command, {
    cwd: options.cwd,
    timeout: options.timeoutSeconds,
    maxOutputChars: options.maxOutputChars,
    context: context as ToolExecutionContext | null,
    env: options.env,
  });
  return result.asDict() as ToolResult;
}

// Serializes write/edit critical sections per resolved file path, mirroring
// the Python module-level _MUTATION_LOCKS keyed by Path.
const mutationLocks = new Map<string, Promise<void>>();

async function withFileMutationLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = mutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  mutationLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (mutationLocks.get(key) === tail) {
      mutationLocks.delete(key);
    }
  }
}

/** Non-strict realpath: resolves symlinks for the deepest existing ancestor
 * and appends the not-yet-created remainder (Python Path.resolve semantics). */
async function resolveNonStrict(pathname: string): Promise<string> {
  const missing: string[] = [];
  let current = pathname;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function resolveNonStrictSync(pathname: string): string {
  const missing: string[] = [];
  let current = pathname;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Counts non-overlapping occurrences, matching Python str.count
 * (including the empty-needle edge: len(text) + 1). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid argument: ${key}`);
  }
  return value;
}

function cancelledResult(context: ToolExecutionContextLike): ToolResult {
  return {
    ok: false,
    status: "cancelled",
    error: context.cancellationReason,
  };
}

export interface ToolRegistryOptions {
  bashTimeoutSeconds?: number;
  maxOutputChars?: number;
  executionModes?: Record<string, ToolExecutionMode>;
  runBash?: RunBash;
  io?: ToolFileIo;
}

/** Execute the small set of tools exposed to the model. */
export class ToolRegistry {
  readonly root: string;
  readonly bashTimeoutSeconds: number;
  readonly maxOutputChars: number;
  readonly executionModes: Record<string, ToolExecutionMode>;
  private readonly runBash: RunBash;
  private readonly io: ToolFileIo;

  constructor(root: string, options: ToolRegistryOptions = {}) {
    this.root = resolveNonStrictSync(path.resolve(root));
    this.bashTimeoutSeconds = options.bashTimeoutSeconds ?? 120;
    this.maxOutputChars = options.maxOutputChars ?? 20_000;
    this.executionModes = { ...(options.executionModes ?? {}) };
    this.runBash = options.runBash ?? defaultRunBash;
    this.io = options.io ?? DEFAULT_IO;
  }

  get definitions(): ToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  executionMode(name: string): ToolExecutionMode | undefined {
    return this.executionModes[name];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> {
    const execution = context ?? NOOP_CONTEXT;
    try {
      if (execution.isCancelled()) {
        return cancelledResult(execution);
      }

      if (name === "read") {
        const target = await this.resolvePath(stringArgument(args, "path"));
        const content = await this.io.readFile(target);
        if (execution.isCancelled()) {
          return cancelledResult(execution);
        }
        return { ok: true, content: this.truncate(content) };
      }

      if (name === "write") {
        const rawPath = stringArgument(args, "path");
        const target = await this.resolvePath(rawPath);
        return await withFileMutationLock(target, async () => {
          if (execution.isCancelled()) {
            return cancelledResult(execution);
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await this.io.writeFile(target, stringArgument(args, "content"));
          return { ok: true, path: rawPath };
        });
      }

      if (name === "edit") {
        const rawPath = stringArgument(args, "path");
        const target = await this.resolvePath(rawPath);
        return await withFileMutationLock(target, async () => {
          if (execution.isCancelled()) {
            return cancelledResult(execution);
          }
          const content = await this.io.readFile(target);
          const oldText = stringArgument(args, "old_text");
          const matches = countOccurrences(content, oldText);
          if (matches !== 1) {
            throw new Error(
              `old_text must appear exactly once; found ${matches} matches`,
            );
          }
          if (execution.isCancelled()) {
            return cancelledResult(execution);
          }
          await this.io.writeFile(
            target,
            content.replace(oldText, stringArgument(args, "new_text")),
          );
          return { ok: true, path: rawPath };
        });
      }

      if (name === "bash") {
        return await this.runBash(stringArgument(args, "command"), {
          cwd: this.root,
          timeoutSeconds: this.bashTimeoutSeconds,
          maxOutputChars: this.maxOutputChars,
          context: execution,
          env: process.env,
        });
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolvePath(rawPath: string): Promise<string> {
    const resolved = await resolveNonStrict(path.resolve(this.root, rawPath));
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Path is outside the project root: ${rawPath}`);
    }
    return resolved;
  }

  private truncate(text: string): string {
    if (text.length <= this.maxOutputChars) {
      return text;
    }
    const omitted = text.length - this.maxOutputChars;
    return `${text.slice(0, this.maxOutputChars)}\n...[truncated ${omitted} chars]`;
  }
}
