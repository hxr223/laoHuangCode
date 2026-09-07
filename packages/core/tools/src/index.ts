import type { CancelToken } from "@laohuang/runtime-protocol";

/**
 * Internal immutable specification for one fixed tool. `promptGuidelines`
 * feeds only the stable System Prompt; it is never serialized into the model
 * tools payload.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly promptGuidelines: readonly string[];
}

export type ToolExecutionMode = "parallel" | "sequential";

/**
 * Internal side channel: the resolved absolute path touched by a successful
 * first-party file tool, attached non-enumerably so it never serializes into
 * model-visible history.
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

/** Attach the touched path invisibly to a successful file-tool result. */
export function withTouchedPath(result: ToolResult, target: string): ToolResult {
  Object.defineProperty(result, TOUCHED_PATH, {
    value: target,
    enumerable: false,
    configurable: true,
  });
  return result;
}

export interface ToolExecutionContextLike {
  isCancelled(): boolean;
  readonly cancellationReason: string;
  publish?(kind: string, payload: Record<string, unknown>): unknown;
}

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
  cancelToken?: CancelToken | null;
  eventSink?: ToolEventSink | null;
}

/** Runtime metadata and optional cooperative services for a tool call. */
export class ToolExecutionContext implements ToolExecutionContextLike {
  sessionId: string | null;
  taskId: string | null;
  toolCallId: string | null;
  cancelToken: CancelToken | null;
  eventSink: ToolEventSink | null;

  constructor(init: ToolExecutionContextInit = {}) {
    this.sessionId = init.sessionId ?? null;
    this.taskId = init.taskId ?? null;
    this.toolCallId = init.toolCallId ?? null;
    this.cancelToken = init.cancelToken ?? null;
    this.eventSink = init.eventSink ?? null;
  }

  isCancelled(): boolean {
    return this.cancelToken?.isCancelled() ?? false;
  }

  get cancellationReason(): string {
    return this.cancelToken?.reason || "cancelled";
  }

  /** Publish through an EventBus, with a tiny callback fallback for tests. */
  publish(kind: string, payload: Record<string, unknown>): unknown {
    const sink = this.eventSink;
    if (sink == null) return;

    if (typeof sink === "function") {
      return sink(kind, payload);
    }

    return sink.publish(kind, {
      source: "tool",
      session_id: this.sessionId ?? "local",
      task_id: this.taskId,
      correlation_id: this.toolCallId,
      payload,
    });
  }
}

export const NOOP_TOOL_CONTEXT: ToolExecutionContextLike = {
  isCancelled: () => false,
  cancellationReason: "cancelled",
  publish: () => {},
};

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolAdapterDefinition {
  readonly spec: ToolSpec;
  readonly executionMode?: ToolExecutionMode;
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContextLike,
  ): Promise<ToolResult> | ToolResult;
}

/** Structural tool surface consumed by the agent and ToolRuntime. */
export interface ToolRegistryLike {
  readonly definitions: readonly ToolSpec[];
  readonly orderedSpecs: readonly ToolSpec[];
  executionMode(name: string): ToolExecutionMode | undefined;
  execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> | ToolResult;
}

export interface ToolRegistryOptions {
  executionModes?: Record<string, ToolExecutionMode>;
}

/** Executes tool definitions and exposes their model payload in stable order. */
export class ToolRegistry implements ToolRegistryLike {
  private readonly tools = new Map<string, ToolAdapterDefinition>();
  private readonly modeOverrides: Record<string, ToolExecutionMode>;

  constructor(
    definitions: readonly ToolAdapterDefinition[],
    options: ToolRegistryOptions = {},
  ) {
    for (const definition of definitions) {
      if (this.tools.has(definition.spec.name)) {
        throw new Error(`Duplicate tool: ${definition.spec.name}`);
      }
      this.tools.set(definition.spec.name, definition);
    }
    this.modeOverrides = { ...(options.executionModes ?? {}) };
  }

  get definitions(): ToolSpec[] {
    return this.orderedSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      promptGuidelines: [...spec.promptGuidelines],
    }));
  }

  get orderedSpecs(): readonly ToolSpec[] {
    return [...this.tools.values()].map((definition) => definition.spec);
  }

  executionMode(name: string): ToolExecutionMode | undefined {
    return this.modeOverrides[name] ?? this.tools.get(name)?.executionMode;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> {
    const definition = this.tools.get(name);
    if (definition === undefined) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    const execution = context ?? NOOP_TOOL_CONTEXT;
    try {
      if (execution.isCancelled()) {
        return cancelledResult(execution);
      }
      return await definition.execute(args, execution);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

export function cancelledResult(context: ToolExecutionContextLike): ToolResult {
  return {
    ok: false,
    status: "cancelled",
    error: context.cancellationReason,
  };
}

export function stringArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`Missing or invalid argument: ${key}`);
  }
  return value;
}

/** Optional positive-integer argument; undefined when absent. */
export function optionalPositiveInteger(
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

export function truncateText(text: string, maxOutputChars: number): string {
  if (text.length <= maxOutputChars) {
    return text;
  }
  const omitted = text.length - maxOutputChars;
  return `${text.slice(0, maxOutputChars)}\n...[truncated ${omitted} chars]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export * from "./tool-runtime.ts";
