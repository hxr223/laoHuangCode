import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";

import {
  cancelledResult,
  optionalPositiveInteger,
  stringArgument,
  withTouchedPath,
  type ToolAdapterDefinition,
  type ToolExecutionContextLike,
} from "@laohuang/tools";

export interface ToolFileIo {
  readFile(target: string): Promise<string>;
  writeFile(target: string, content: string): Promise<void>;
}

export interface FileToolDefinitionOptions {
  projectRoot: string;
  fileIo?: ToolFileIo;
}

const READ_MAX_BYTES = 50 * 1024;
const READ_MAX_LINES = 2000;
const READ_MAX_LINE_CHARACTERS = 2000;

const DEFAULT_IO: ToolFileIo = {
  readFile: (target) => fs.readFile(target, "utf8"),
  writeFile: (target, content) => fs.writeFile(target, content, "utf8"),
};

// Serializes write/edit critical sections per resolved file path.
const mutationLocks = new Map<string, Promise<void>>();

export function createFileToolDefinitions(
  options: FileToolDefinitionOptions,
): ToolAdapterDefinition[] {
  const root = resolveNonStrictSync(path.resolve(options.projectRoot));
  const io = options.fileIo ?? DEFAULT_IO;

  const resolvePath = (rawPath: string): Promise<string> =>
    resolveNonStrict(path.resolve(root, rawPath));

  return [
    {
      spec: {
        name: "read",
        description:
          "Read a UTF-8 text file, up to 50 KiB of content, 2000 lines, and 2000 Unicode characters per line. " +
          "has_more reports omitted content; next_offset resumes at the next unread line, or is null at EOF. " +
          "truncated_line_numbers identifies shortened lines; use Bash to inspect their omitted content.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path or path relative to the default working directory.",
            },
            offset: {
              type: "integer",
              description: "1-based line number to start reading from.",
              minimum: 1,
            },
            limit: {
              type: "integer",
              description: "Maximum number of lines to return (default and maximum: 2000).",
              minimum: 1,
              maximum: READ_MAX_LINES,
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
      execute: async (args, execution) => {
        const target = await resolvePath(stringArgument(args, "path"));
        const offset = optionalPositiveInteger(args, "offset") ?? 1;
        const limit = optionalPositiveInteger(args, "limit") ?? READ_MAX_LINES;
        if (limit > READ_MAX_LINES) {
          throw new Error(`limit must be less than or equal to ${READ_MAX_LINES}`);
        }
        const content = await io.readFile(target);
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
        const window: string[] = [];
        const truncatedLineNumbers: number[] = [];
        let bytes = 0;
        for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
          const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
          const body = line.slice(0, line.length - ending.length);
          let end = 0;
          let characters = 0;
          // Iterate code points so truncation cannot split a surrogate pair.
          for (const character of body) {
            if (characters === READ_MAX_LINE_CHARACTERS) break;
            end += character.length;
            characters += 1;
          }
          const rendered = body.slice(0, end) + ending;
          const lineBytes = Buffer.byteLength(rendered, "utf8");
          if (bytes + lineBytes > READ_MAX_BYTES) break;
          if (end < body.length) truncatedLineNumbers.push(offset + window.length);
          window.push(rendered);
          bytes += lineBytes;
        }
        const nextOffset = offset - 1 + window.length < totalLines ? offset + window.length : null;
        return withTouchedPath(
          {
            ok: true,
            content: window.join(""),
            offset,
            limit,
            total_lines: totalLines,
            has_more: nextOffset !== null || truncatedLineNumbers.length > 0,
            next_offset: nextOffset,
            truncated_line_numbers: truncatedLineNumbers,
            ...(truncatedLineNumbers.length > 0 ? {
              note: "Listed lines were truncated to 2000 Unicode characters. Use Bash to inspect their omitted content; next_offset only continues to later lines.",
            } : {}),
          },
          target,
        );
      },
    },
    {
      spec: {
        name: "write",
        description: "Create or fully overwrite a UTF-8 text file.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path or path relative to the default working directory.",
            },
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
      executionMode: "sequential",
      execute: async (args, execution) => {
        const rawPath = stringArgument(args, "path");
        const target = await resolvePath(rawPath);
        return await withFileMutationLock(target, async () => {
          if (execution.isCancelled()) {
            return cancelledResult(execution);
          }
          await fs.mkdir(path.dirname(target), { recursive: true });
          await io.writeFile(target, stringArgument(args, "content"));
          return withTouchedPath({ ok: true, path: rawPath }, target);
        });
      },
    },
    {
      spec: {
        name: "edit",
        description:
          "Apply a batch of exact, unique text replacements to a file atomically.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path or path relative to the default working directory.",
            },
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
      executionMode: "sequential",
      execute: async (args, execution) => executeEdit(args, execution, resolvePath, io),
    },
  ];
}

async function executeEdit(
  args: Record<string, unknown>,
  execution: ToolExecutionContextLike,
  resolvePath: (rawPath: string) => Promise<string>,
  io: ToolFileIo,
): Promise<ReturnType<ToolAdapterDefinition["execute"]>> {
  const rawPath = stringArgument(args, "path");
  const target = await resolvePath(rawPath);
  const edits = editsArgument(args);
  return await withFileMutationLock(target, async () => {
    if (execution.isCancelled()) {
      return cancelledResult(execution);
    }
    const content = await io.readFile(target);
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
    await io.writeFile(target, updated);
    return withTouchedPath({ ok: true, path: rawPath }, target);
  });
}

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

/** Non-strict realpath: resolves symlinks for the deepest existing ancestor. */
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

/** Counts non-overlapping occurrences, matching Python str.count. */
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
