import { randomUUID } from "node:crypto";
import type { CancelToken } from "@laohuang/runtime-protocol";
import type { AttachmentContent } from "@laohuang/attachment";
import { touchedPathOf } from "./index.ts";
import type { ToolCall, ToolExecutionContextLike, ToolExecutionMode, ToolRegistryLike, ToolResult, ToolSpec } from "./index.ts";

export interface ToolRuntimeRequest {
  registry?: ToolRegistryLike;
  callableTools?: ToolRegistryLike;
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
  readonly parentToolCallId?: string;
  readonly rootToolCallId: string;
  readonly orchestrator: boolean;
}

export interface ToolRuntimeToolResultEvent extends ToolRuntimeToolEvent {
  readonly result: ToolResult;
  readonly durationMs: number;
}

/** Only root results become model tool-result messages. */
export interface ToolBatchResult {
  readonly results: readonly ToolResult[];
  readonly touchedPaths: readonly string[];
}

export type ToolExecutionContextFactory = (toolCallId: string, cancelToken: CancelToken | null) => ToolExecutionContextLike;
export type ToolArgumentValidator = (tool: ToolSpec, toolCall: ToolCall, args: Record<string, unknown>) => Record<string, unknown>;

/** One batch owns the lifetime, validation and scheduler of all its descendants. */
export class ToolRuntime {
  private readonly tools: ToolRegistryLike;
  private readonly createExecutionContext: ToolExecutionContextFactory;
  private readonly validateArguments: ToolArgumentValidator;

  constructor(tools: ToolRegistryLike, options: {
    validateToolArguments: ToolArgumentValidator;
    createExecutionContext?: ToolExecutionContextFactory;
  }) {
    if (typeof options?.validateToolArguments !== "function") throw new Error("Tool argument validator is required");
    this.tools = tools;
    this.validateArguments = options.validateToolArguments;
    this.createExecutionContext = options.createExecutionContext ?? ((_, token) => ({
      signal: token?.signal,
      isCancelled: () => token?.isCancelled() ?? false,
      get cancellationReason() { return token?.reason || "cancelled"; },
    }));
  }

  async execute(request: ToolRuntimeRequest): Promise<ToolBatchResult> {
    const registry = request.registry ?? this.tools.snapshot?.() ?? this.tools;
    const callable = request.callableTools;
    const scheduler = new ToolScheduler();
    const touchedPaths = new Set<string>();
    const cancelled = (): ToolResult => ({ ok: false, status: "cancelled", error: request.cancelToken?.reason || "cancelled" });

    const run = async (toolCall: ToolCall, surface: ToolRegistryLike, index: number, batchSize: number,
      rootToolCallId: string, parentToolCallId?: string): Promise<ToolResult> => {
      const started = performance.now();
      let args: Record<string, unknown> = {};
      let invalid: ToolResult | undefined;
      const spec = surface.definitions.find(tool => tool.name === toolCall.name);
      try {
        if (!spec) throw new Error(`Unknown tool: ${toolCall.name} (unavailable in this execution context)`);
        if (parentToolCallId && spec.executionRole === "orchestrator") throw new Error("Nested orchestration tools are unavailable");
        const decoded: unknown = JSON.parse(toolCall.arguments);
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Tool arguments must be a JSON object");
        args = this.validateArguments(spec, toolCall, decoded as Record<string, unknown>);
      } catch (error) {
        invalid = { ok: false, error: errorMessage(error) };
      }
      const event: ToolRuntimeToolEvent = { toolCall, args, index, batchSize, rootToolCallId, orchestrator: spec?.executionRole === "orchestrator",
        ...(parentToolCallId ? { parentToolCallId } : {}) };
      request.onToolStart?.(event);
      const attachments: AttachmentContent[] = [];
      const execute = async (): Promise<ToolResult> => {
        if (request.cancelToken?.isCancelled()) return cancelled();
        const base = this.createExecutionContext(toolCall.id, request.cancelToken);
        const children: Promise<ToolResult>[] = [];
        let open = true;
        const context: ToolExecutionContextLike = Object.assign(Object.create(base) as ToolExecutionContextLike, {
          toolCallId: toolCall.id,
          ...(parentToolCallId ? { parentToolCallId } : {}),
          publish: (kind: string, payload: Record<string, unknown>) => {
            if (!open || parentToolCallId && (kind === "tool.started" || kind === "tool.finished")) return;
            return base.publish?.(kind, {
            ...payload, toolCallId: toolCall.id, rootToolCallId,
            ...(parentToolCallId ? { parentToolCallId } : {}),
            });
          },
        });
        if (spec?.executionRole === "orchestrator" && callable) {
          Object.assign(context, {
            callableTools: callable.definitions,
            executeTool: (name: string, childArgs: Record<string, unknown>): Promise<ToolResult> => {
              if (!open) return Promise.resolve({ ok: false, status: "scope_closed", error: "Parent tool execution has ended." });
              if (request.cancelToken?.isCancelled()) return Promise.resolve(cancelled());
              let encoded: string;
              try { encoded = JSON.stringify(childArgs); }
              catch { return Promise.resolve({ ok: false, error: "Tool arguments must be JSON serializable." }); }
              const child = run({ id: randomUUID(), name, arguments: encoded }, callable, children.length + 1, 1, rootToolCallId, toolCall.id);
              children.push(child);
              return child;
            },
          });
        }
        let result: ToolResult;
        try { result = await surface.execute(toolCall.name, args, context); }
        catch (error) { result = { ok: false, error: errorMessage(error) }; }
        finally {
          open = false;
          // Unawaited children belong to this scope, including on parent failure.
          const completed = await Promise.all(children);
          for (const child of completed) attachments.push(...child.attachmentContent ?? []);
        }
        return result;
      };
      const exclusive = request.executionMode === "sequential" || surface.executionMode(toolCall.name) === "sequential" || toolCall.name === "write" || toolCall.name === "edit";
      let result = invalid ?? await (spec?.executionRole === "orchestrator" ? execute() : scheduler.run(exclusive, execute));
      const touched = touchedPathOf(result);
      if (result.ok && touched) touchedPaths.add(touched);
      if (attachments.length) result = { ...result, attachmentContent: [...result.attachmentContent ?? [], ...attachments] };
      request.onToolResult?.({ ...event, result, durationMs: performance.now() - started });
      return result;
    };

    // Preserve existing whole-batch ordering for direct sequential/write/edit calls.
    const serial = request.executionMode === "sequential" || request.toolCalls.some(call =>
      registry.executionMode(call.name) === "sequential" || call.name === "write" || call.name === "edit");
    const results: ToolResult[] = [];
    if (serial) {
      for (const [index, call] of request.toolCalls.entries()) results.push(await run(call, registry, index + 1, request.toolCalls.length, call.id));
    } else {
      results.push(...await Promise.all(request.toolCalls.map((call, index) => run(call, registry, index + 1, request.toolCalls.length, call.id))));
    }
    return { results, touchedPaths: [...touchedPaths] };
  }
}

/** FIFO reader/writer scheduling shared by direct calls and nested leaf calls. */
class ToolScheduler {
  private readonly queue: { exclusive: boolean; start(): void }[] = [];
  private running = 0;
  private exclusive = false;

  run(exclusive: boolean, execute: () => Promise<ToolResult>): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ exclusive, start: () => {
        this.running++;
        this.exclusive = exclusive;
        void execute().then(resolve, reject).finally(() => {
          this.running--;
          if (exclusive) this.exclusive = false;
          this.drain();
        });
      } });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length && !this.exclusive) {
      const next = this.queue[0]!;
      if (next.exclusive && this.running) return;
      this.queue.shift();
      next.start();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
