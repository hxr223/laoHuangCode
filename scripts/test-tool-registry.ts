import {
  ToolRegistry,
  type ToolExecutionMode,
} from "../packages/core/tools/src/index.ts";
import {
  createFileToolDefinitions,
  type ToolFileIo,
} from "../packages/fs/tool-fs/src/index.ts";
import {
  createBashToolDefinition,
  type RunBash,
} from "../packages/shell/tool-bash/src/index.ts";

export interface TestToolRegistryOptions {
  bashTimeoutSeconds?: number;
  maxOutputBytes?: number;
  executionModes?: Record<string, ToolExecutionMode>;
  runBash?: RunBash;
  io?: ToolFileIo;
}

export function createTestToolRegistry(
  projectRoot: string,
  options: TestToolRegistryOptions = {},
): ToolRegistry {
  return new ToolRegistry(
    [
      ...createFileToolDefinitions({
        projectRoot,
        fileIo: options.io,
      }),
      createBashToolDefinition({
        projectRoot,
        bashTimeoutSeconds: options.bashTimeoutSeconds,
        maxOutputBytes: options.maxOutputBytes,
        runBash: options.runBash,
      }),
    ],
    { executionModes: options.executionModes },
  );
}
