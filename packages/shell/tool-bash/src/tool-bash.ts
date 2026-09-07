import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";

import { resolveBashPath, runBash as runBashCommand, type BashOutputOptions } from "@laohuang/bash-local";
import { resolveLocalPath } from "@laohuang/local-paths";
import {
  optionalPositiveInteger,
  stringArgument,
  type ToolAdapterDefinition,
  type ToolExecutionContextLike,
  type ToolResult,
} from "@laohuang/tools";

export interface RunBashOptions extends BashOutputOptions {
  cwd: string;
  shellPath?: string | undefined;
  timeoutSeconds: number;
  context: ToolExecutionContextLike;
  env: Record<string, string | undefined>;
}

export type RunBash = (
  command: string,
  options: RunBashOptions,
) => Promise<ToolResult>;

export interface BashToolDefinitionOptions extends BashOutputOptions {
  projectRoot: string;
  shellPath?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  bashTimeoutSeconds?: number;
  runBash?: RunBash;
}

export function createBashToolDefinition(
  options: BashToolDefinitionOptions,
): ToolAdapterDefinition {
  const pathOptions = {
    env: options.env ?? process.env,
    shellPath: () => resolveBashPath({ shellPath: options.shellPath, env: options.env }),
  };
  const root = resolveNonStrictSync(resolveLocalPath(options.projectRoot, process.cwd(), pathOptions));
  const bashTimeoutSeconds = options.bashTimeoutSeconds ?? 120;
  const runBash = options.runBash ?? defaultRunBash;

  return {
    spec: {
      name: "bash",
      description: "Run a Bash command. Returns stdout and stderr, limited together to the latest 2000 lines or 50KiB by default. When truncated, output_files contains saved output paths; check output_file_complete before assuming the files are complete.",
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
              "Absolute working directory or path relative to the default working directory. Defaults to the default working directory.",
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
        "When output is truncated, use read or a targeted Bash search on output_files instead of repeating the command. Saved output expires after 7 days; files are capped at 64MiB per call.",
      ],
    },
    execute: async (args, execution) => {
      const command = stringArgument(args, "command");
      // Required by the schema; validated here too so direct execute() callers
      // get the same enforcement.
      stringArgument(args, "description");
      const workdir = args["workdir"];
      const cwd =
        workdir === undefined
          ? root
          : await resolveNonStrict(resolveLocalPath(stringArgument(args, "workdir"), root, pathOptions));
      const timeoutMs = optionalPositiveInteger(args, "timeoutMs");
      return await runBash(command, {
        cwd,
        shellPath: options.shellPath,
        timeoutSeconds:
          timeoutMs === undefined ? bashTimeoutSeconds : timeoutMs / 1000,
        maxOutputBytes: options.maxOutputBytes,
        maxOutputLines: options.maxOutputLines,
        outputDirectory: options.outputDirectory,
        maxOutputFileBytes: options.maxOutputFileBytes,
        context: execution,
        env: options.env ?? process.env,
      });
    },
  };
}

async function defaultRunBash(
  command: string,
  options: RunBashOptions,
): Promise<ToolResult> {
  // Preserve cancellation even when a host has no event publisher, and
  // forward asynchronous publication rather than discarding its promise.
  const execution = options.context;
  const context = {
    isCancelled: () => execution.isCancelled(),
    get cancellationReason() { return execution.cancellationReason; },
    publish: (kind: string, payload: Record<string, unknown>) => execution.publish?.(kind, payload),
  };
  const result = await runBashCommand(command, {
    cwd: options.cwd,
    shellPath: options.shellPath,
    timeout: options.timeoutSeconds,
    maxOutputBytes: options.maxOutputBytes,
    maxOutputLines: options.maxOutputLines,
    outputDirectory: options.outputDirectory,
    maxOutputFileBytes: options.maxOutputFileBytes,
    context,
    env: options.env,
  });
  return result.asDict() as ToolResult;
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
