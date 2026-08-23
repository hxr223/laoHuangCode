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

/**
 * Internal immutable specification for one fixed tool. `promptGuidelines`
 * feeds only the stable System Prompt (system-prompt.ts); it is never
 * serialized into the OpenAI tools payload.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly promptGuidelines: readonly string[];
}

/** The fixed tool set, in the canonical prompt/schema order. */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "read",
    description: "Read a UTF-8 text file inside the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." },
        offset: {
          type: "integer",
          description: "1-based line number to start reading from.",
          minimum: 1,
        },
        limit: {
          type: "integer",
          description: "Maximum number of lines to return.",
          minimum: 1,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    promptGuidelines: [
      "Use read for ordinary file inspection rather than cat/sed.",
      "Use offset/limit to page through large files.",
      "Inspect an existing file before changing it.",
    ],
  },
  {
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
    promptGuidelines: [
      "Use write only to create a file or replace all of one; use edit for local changes.",
      "Confirm the path and the complete content before writing.",
    ],
  },
  {
    name: "edit",
    description:
      "Apply a batch of exact, unique text replacements to a file atomically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." },
        edits: {
          type: "array",
          description:
            "Non-empty list of exact replacements, matched against the original file content.",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              old_text: {
                type: "string",
                description:
                  "Exact text to replace; must appear exactly once in the original content.",
              },
              new_text: { type: "string", description: "Replacement text." },
            },
            required: ["old_text", "new_text"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    },
    promptGuidelines: [
      "Use edit for local changes; targets must exactly and uniquely match the original file.",
      "Edits in one batch are matched against the original content and must not overlap.",
      "Inspect the file first and verify the change when practical.",
    ],
  },
  {
    name: "bash",
    description: "Run a Bash command inside the project root.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command." },
        description: {
          type: "string",
          description: "Concise purpose of the command.",
        },
        workdir: {
          type: "string",
          description:
            "Working directory for the command; must resolve inside the project root. Defaults to the project root.",
        },
        timeoutMs: {
          type: "integer",
          description: "Timeout in milliseconds.",
          minimum: 1,
        },
      },
      required: ["command", "description"],
      additionalProperties: false,
    },
    promptGuidelines: [
      "Supply a concise description of what the command does.",
      "Use workdir instead of cd.",
      "Each call runs in an independent shell; state does not persist between calls.",
      "On a non-zero exit, inspect the output before retrying.",
    ],
  },
];

export type ToolExecutionMode = "parallel" | "sequential";

/**
 * Internal side channel: the resolved absolute path touched by a successful
 * first-party file tool (read/write/edit), attached non-enumerably so it
 * never serializes into model-visible history. Consumed only by the agent
 * layer for project-instruction discovery.
 */
export const TOUCHED_PATH: unique symbol = Symbol("laohuang.touchedPath");

/** Plain-object result returned to the model for every tool call. */
export interface ToolResult {
  ok: boolean;
  status?: string;
  content?: string;
  path?: string;
  error?: string;
  [TOUCHED_PATH]?: string;
  [key: string]: unknown;
}

/** The resolved path a successful file tool touched, if recorded. */
export function touchedPathOf(result: ToolResult): string | undefined {
  return result[TOUCHED_PATH];
}

/** Attach the touched path invisibly: JSON.stringify, spreads, and
 * Object.entries all skip non-enumerable symbol properties. */
function withTouchedPath(result: ToolResult, target: string): ToolResult {
  Object.defineProperty(result, TOUCHED_PATH, {
    value: target,
    enumerable: false,
    configurable: true,
  });
  return result;
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

/** Structural tool surface consumed by the agent and ToolRuntime. */
export interface ToolRegistryLike {
  readonly definitions: readonly ToolDefinition[];
  readonly orderedSpecs: readonly ToolSpec[];
  executionMode(name: string): ToolExecutionMode | undefined;
  execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> | ToolResult;
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

/** Optional positive-integer argument; undefined when absent. */
function optionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Argument ${key} must be a positive integer`);
  }
  return value;
}

interface EditOperation {
  oldText: string;
  newText: string;
}

/** Validate the batched `edits` argument (non-empty array of pairs). */
function editsArgument(args: Record<string, unknown>): EditOperation[] {
  const value = args["edits"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Missing or invalid argument: edits");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`edits[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    return {
      oldText: stringArgument(record, "old_text"),
      newText: stringArgument(record, "new_text"),
    };
  });
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
    // promptGuidelines never leaks into the OpenAI tools payload.
    return TOOL_SPECS.map((spec) => ({
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    }));
  }

  /** Ordered fixed specs, consumed by the System Prompt builder. */
  get orderedSpecs(): readonly ToolSpec[] {
    return TOOL_SPECS;
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
        const offset = optionalPositiveInteger(args, "offset") ?? 1;
        const limit = optionalPositiveInteger(args, "limit");
        const content = await this.io.readFile(target);
        if (execution.isCancelled()) {
          return cancelledResult(execution);
        }
        // Split after each newline so a window rejoins byte-identically.
        const lines = content === "" ? [] : content.split(/(?<=\n)/);
        const totalLines = lines.length;
        if (offset > Math.max(totalLines, 1)) {
          throw new Error(
            `offset ${offset} is out of range; the file has ${totalLines} lines`,
          );
        }
        const window = lines.slice(
          offset - 1,
          limit === undefined ? undefined : offset - 1 + limit,
        );
        return withTouchedPath(
          {
            ok: true,
            content: this.truncate(window.join("")),
            offset,
            limit: limit ?? null,
            total_lines: totalLines,
            has_more: offset - 1 + window.length < totalLines,
          },
          target,
        );
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
          return withTouchedPath({ ok: true, path: rawPath }, target);
        });
      }

      if (name === "edit") {
        const rawPath = stringArgument(args, "path");
        const target = await this.resolvePath(rawPath);
        const edits = editsArgument(args);
        return await withFileMutationLock(target, async () => {
          if (execution.isCancelled()) {
            return cancelledResult(execution);
          }
          const content = await this.io.readFile(target);
          // Every edit matches against the pre-edit original content.
          const ranges = edits.map((edit, index) => {
            const matches = countOccurrences(content, edit.oldText);
            if (matches !== 1) {
              throw new Error(
                `edits[${index}]: old_text must appear exactly once; ` +
                  `found ${matches} matches`,
              );
            }
            const start = content.indexOf(edit.oldText);
            return { start, end: start + edit.oldText.length, index };
          });
          const ordered = [...ranges].sort((a, b) => a.start - b.start);
          for (let i = 1; i < ordered.length; i += 1) {
            const previous = ordered[i - 1]!;
            const current = ordered[i]!;
            if (current.start < previous.end) {
              throw new Error(
                `edits[${previous.index}] and edits[${current.index}] overlap`,
              );
            }
          }
          let updated = "";
          let cursor = 0;
          for (const range of ordered) {
            updated += content.slice(cursor, range.start);
            updated += edits[range.index]!.newText;
            cursor = range.end;
          }
          updated += content.slice(cursor);
          if (execution.isCancelled()) {
            return cancelledResult(execution);
          }
          await this.io.writeFile(target, updated);
          return withTouchedPath({ ok: true, path: rawPath }, target);
        });
      }

      if (name === "bash") {
        const command = stringArgument(args, "command");
        // Required by the schema; validated here too so direct execute()
        // callers get the same enforcement.
        stringArgument(args, "description");
        const workdir = args["workdir"];
        const cwd =
          workdir === undefined
            ? this.root
            : await this.resolvePath(stringArgument(args, "workdir"));
        const timeoutMs = optionalPositiveInteger(args, "timeoutMs");
        return await this.runBash(command, {
          cwd,
          timeoutSeconds:
            timeoutMs === undefined ? this.bashTimeoutSeconds : timeoutMs / 1000,
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
