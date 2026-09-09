import type { CancelToken } from "@laohuang/runtime-protocol";
import type {
  ToolCall,
  ToolExecutionContextLike,
  ToolExecutionMode,
  ToolRegistryLike,
  ToolResult,
} from "./index.ts";

export interface ToolRuntimeRequest {
  registry?: ToolRegistryLike;
  toolCalls: readonly ToolCall[];
  executionMode: ToolExecutionMode;
  cancelToken: CancelToken | null;
  onToolStart?: ((event: ToolRuntimeToolEvent) => void) | null;
  onToolResult?: ((event: ToolRuntimeToolResultEvent) => void) | null;
}

export interface ToolRuntimeToolEvent {
  readonly index: number;
  readonly batchSize: number;
  readonly toolCall: ToolCall;
  readonly args: Record<string, unknown>;
}

export interface ToolRuntimeToolResultEvent extends ToolRuntimeToolEvent {
  readonly result: ToolResult;
}

/** Tool results are always in source order, even when execution is parallel. */
export interface ToolBatchResult {
  readonly results: readonly ToolResult[];
}

export type ToolExecutionContextFactory = (
  toolCallId: string,
  cancelToken: CancelToken | null,
) => ToolExecutionContextLike;

/** Owns tool-call argument decoding, scheduling, and cooperative cancellation. */
export class ToolRuntime {
  private readonly tools: ToolRegistryLike;
  private readonly createExecutionContext: ToolExecutionContextFactory;

  constructor(
    tools: ToolRegistryLike,
    options: { createExecutionContext?: ToolExecutionContextFactory } = {},
  ) {
    this.tools = tools;
    this.createExecutionContext = options.createExecutionContext ??
      ((_, cancelToken) => ({
        signal: cancelToken?.signal,
        isCancelled: () => isCancelled(cancelToken),
        cancellationReason: cancelToken?.reason || "cancelled",
        publish: () => {},
      }));
  }

  async execute(request: ToolRuntimeRequest): Promise<ToolBatchResult> {
    const registry = request.registry ?? this.tools;
    interface Prepared extends ToolRuntimeToolEvent {}

    const results: Array<ToolResult | undefined> = new Array<ToolResult | undefined>(
      request.toolCalls.length,
    ).fill(undefined);
    const prepared: Prepared[] = [];

    for (let offset = 0; offset < request.toolCalls.length; offset += 1) {
      const toolCall = request.toolCalls[offset];
      if (toolCall === undefined) {
        continue;
      }
      let args: Record<string, unknown>;
      let result: ToolResult | undefined;
      try {
        const decoded: unknown = JSON.parse(toolCall.arguments);
        if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
          throw new Error("Tool arguments must be a JSON object");
        }
        args = decoded as Record<string, unknown>;
      } catch (error) {
        args = { _raw: toolCall.arguments };
        result = { ok: false, error: errorMessage(error) };
      }
      const event: ToolRuntimeToolEvent = {
        index: offset + 1,
        batchSize: request.toolCalls.length,
        toolCall,
        args,
      };
      request.onToolStart?.(event);
      if (result === undefined) {
        prepared.push(event);
      } else {
        results[offset] = result;
        request.onToolResult?.({ ...event, result });
      }
    }

    const sequentialBatch = request.executionMode === "sequential" ||
      request.toolCalls.some(
        (toolCall) => registry.executionMode(toolCall.name) === "sequential",
      ) ||
      request.toolCalls.some(
        (toolCall) => toolCall.name === "write" || toolCall.name === "edit",
      );
    const runOne = async (event: Prepared): Promise<void> => {
      let result: ToolResult;
      if (isCancelled(request.cancelToken)) {
        result = cancelledToolResult(request.cancelToken);
      } else {
        try {
          result = await registry.execute(
            event.toolCall.name,
            event.args,
            this.createExecutionContext(event.toolCall.id, request.cancelToken),
          );
        } catch (error) {
          result = { ok: false, error: errorMessage(error) };
        }
      }
      const offset = event.index - 1;
      results[offset] = result;
      request.onToolResult?.({ ...event, result });
    };

    if (sequentialBatch || prepared.length === 1) {
      for (const event of prepared) {
        await runOne(event);
      }
    } else if (prepared.length > 0) {
      await Promise.all(prepared.map((event) => runOne(event)));
    }

    return {
      results: results.map(
        (result) => result ?? { ok: false, error: "Tool execution produced no result" },
      ),
    };
  }
}

function isCancelled(token: CancelToken | null): boolean {
  return token !== null && token.isCancelled();
}

function cancelledToolResult(token: CancelToken | null): ToolResult {
  return { ok: false, status: "cancelled", error: token?.reason || "cancelled" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
