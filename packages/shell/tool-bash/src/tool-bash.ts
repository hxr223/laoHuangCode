import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";

import { runBash as runBashCommand, ToolExecutionContext } from "@laohuang/bash-local";
import {
  optionalPositiveInteger,
  stringArgument,
  type ToolAdapterDefinition,
  type ToolExecutionContextLike,
  type ToolResult,
} from "@laohuang/tools";

export interface RunBashOptions {
  cwd: string;
  shellPath?: string | undefined;
  timeoutSeconds: number;
  maxOutputChars: number;
  context: ToolExecutionContextLike;
  env: Record<string, string | undefined>;
}

export type RunBash = (
  command: string,
  options: RunBashOptions,
) => Promise<ToolResult>;

export interface BashToolDefinitionOptions {
  projectRoot: string;
  shellPath?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  bashTimeoutSeconds?: number;
  maxOutputChars?: number;
  runBash?: RunBash;
}

export function createBashToolDefinition(
  options: BashToolDefinitionOptions,
): ToolAdapterDefinition {
  const root = resolveNonStrictSync(path.resolve(options.projectRoot));
  const bashTimeoutSeconds = options.bashTimeoutSeconds ?? 120;
  const maxOutputChars = options.maxOutputChars ?? 20_000;
  const runBash = options.runBash ?? defaultRunBash;

  return {
    spec: {
      name: "bash",
      description: "Run a Bash command.",
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
          : await resolvePath(root, stringArgument(args, "workdir"));
      const timeoutMs = optionalPositiveInteger(args, "timeoutMs");
      return await runBash(command, {
        cwd,
        shellPath: options.shellPath,
        timeoutSeconds:
          timeoutMs === undefined ? bashTimeoutSeconds : timeoutMs / 1000,
        maxOutputChars,
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
  // Only a context carrying the full publish() surface is safe to hand to
  // bash-runner; anything else (e.g. a bare test stub) is replaced so the
  // runner can fall back to its own default context.
  const context =
    typeof options.context.publish === "function" ? options.context : null;
  const result = await runBashCommand(command, {
    cwd: options.cwd,
    shellPath: options.shellPath,
    timeout: options.timeoutSeconds,
    maxOutputChars: options.maxOutputChars,
    context: context as ToolExecutionContext | null,
    env: options.env,
  });
  return result.asDict() as ToolResult;
}

async function resolvePath(root: string, rawPath: string): Promise<string> {
  return await resolveNonStrict(path.resolve(root, rawPath));
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
