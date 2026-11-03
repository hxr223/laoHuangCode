import { randomUUID } from "node:crypto";
import { CancelToken } from "@laohuang/runtime-protocol";
import { touchedPathOf } from "./index.ts";
import type { ToolCall, ToolChildCallOptions, ToolExecutionContextLike, ToolExecutionMode, ToolRegistryLike, ToolResult, ToolSpec } from "./index.ts";
import { ExecutionScope } from "./execution-scope.ts";

export interface ToolRuntimeRequest {
  registry?: ToolRegistryLike;
  callableTools?: ToolRegistryLike;
  toolCalls: readonly ToolCall[];
  executionMode: ToolExecutionMode;
  cancelToken: CancelToken | null;
  onToolStart?: ((event: ToolRuntimeToolEvent) => void) | null;
  onToolResult?: ((event: ToolRuntimeToolResultEvent) => void) | null;
  onToolSettled?: ((event: ToolRuntimeToolResultEvent) => void) | null;
  createExecutionContext?: ToolExecutionContextFactory;
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

export interface ToolExecutionScope {
  readonly result: Promise<ToolBatchResult>;
  readonly settled: Promise<void>;
  cancel(reason?: string): void;
}

export type ToolExecutionContextFactory = (toolCallId: string, cancelToken: CancelToken | null) => ToolExecutionContextLike;
export type ToolArgumentValidator = (tool: ToolSpec, toolCall: ToolCall, args: Record<string, unknown>) => Record<string, unknown>;

/** Batches own their descendants; physical leaf scheduling spans batches. */
export class ToolRuntime {
  private readonly tools: ToolRegistryLike;
  private readonly createExecutionContext: ToolExecutionContextFactory;
  private readonly validateArguments: ToolArgumentValidator;
  private readonly scheduler = new ToolScheduler();

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

  execute(request: ToolRuntimeRequest): Promise<ToolBatchResult> {
    return this.start(request).result;
  }

  start(request: ToolRuntimeRequest): ToolExecutionScope {
    const scope = new ExecutionScope(request.cancelToken);
    const result = this.executeBatch(request, scope);
    void result.then(() => scope.close(), () => scope.close());
    return { result, settled: scope.settled, cancel: reason => { scope.token.cancel(reason); } };
  }

  private async executeBatch(request: ToolRuntimeRequest, scope: ExecutionScope): Promise<ToolBatchResult> {
    const registry = request.registry ?? this.tools.snapshot?.() ?? this.tools;
    const callable = request.callableTools;
    const touchedPaths = new Set<string>();
    const createContext = request.createExecutionContext ?? this.createExecutionContext;

    const run = async (toolCall: ToolCall, surface: ToolRegistryLike, index: number, batchSize: number,
      rootToolCallId: string, parentToolCallId?: string, token = scope.token): Promise<ToolResult> => {
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
      const children = new Set<CancelToken>();
      let open = true;
      let managedCancellation = false;
      const close = () => {
        open = false;
        for (const child of children) child.cancel("Parent tool execution has ended.");
      };
      const execute = async (): Promise<ToolResult> => {
        if (token.isCancelled()) return cancelled(token);
        const base = createContext(toolCall.id, token);
        let childCount = 0;
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
            manageCancellation: () => { managedCancellation = true; },
            callableTools: callable.definitions,
            executeTool: (name: string, childArgs: Record<string, unknown>, options?: ToolChildCallOptions): Promise<ToolResult> => {
              if (!open) return Promise.resolve({ ok: false, status: "scope_closed", error: "Parent tool execution has ended." });
              if (token.isCancelled()) return Promise.resolve(cancelled(token));
              let encoded: string;
              try { encoded = JSON.stringify(childArgs); }
              catch { return Promise.resolve({ ok: false, error: "Tool arguments must be JSON serializable." }); }
              const childToken = new CancelToken();
              children.add(childToken);
              const unlinkParent = token.register(reason => childToken.cancel(reason));
              const abort = () => childToken.cancel(errorMessage(options?.signal?.reason ?? "cancelled"));
              options?.signal?.addEventListener("abort", abort, { once: true });
              if (options?.signal?.aborted) abort();
              const child = run({ id: randomUUID(), name, arguments: encoded }, callable, ++childCount, 1, rootToolCallId, toolCall.id, childToken).finally(() => {
                children.delete(childToken);
                unlinkParent();
                options?.signal?.removeEventListener("abort", abort);
              });
              return child;
            },
          });
        }
        let result: ToolResult;
        try { result = await surface.execute(toolCall.name, args, context); }
        catch (error) { result = { ok: false, error: errorMessage(error) }; }
        finally { close(); }
        return result;
      };
      const exclusive = request.executionMode === "sequential" || surface.executionMode(toolCall.name) === "sequential" || toolCall.name === "write" || toolCall.name === "edit";
      const actual = scope.track((invalid ? Promise.resolve(invalid) : spec?.executionRole === "orchestrator" ? execute() : this.scheduler.run(exclusive, execute, token)).then(result => {
        const touched = touchedPathOf(result);
        if (result.ok && touched) touchedPaths.add(touched);
        request.onToolSettled?.({ ...event, result, durationMs: performance.now() - started });
        return result;
      }));
      let result: ToolResult;
      if (parentToolCallId || spec?.executionRole === "orchestrator") {
        let unlink: (() => void) | undefined;
        const cancellation = new Promise<ToolResult>(resolve => {
          unlink = token.register(reason => {
            if (!managedCancellation) resolve({ ok: false, status: "cancelled", error: reason });
          });
        });
        try { result = await Promise.race([actual, cancellation]); }
        finally { unlink?.(); close(); }
      } else result = await actual;
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

  run(exclusive: boolean, execute: () => Promise<ToolResult>, token: CancelToken): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const entry = { exclusive, start: () => {
        unlink();
        this.running++;
        this.exclusive = exclusive;
        const release = () => {
          this.running--;
          if (exclusive) this.exclusive = false;
          this.drain();
        };
        void execute().then(result => { release(); resolve(result); }, error => { release(); reject(error); });
      } };
      this.queue.push(entry);
      const unlink = token.register(() => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        resolve(cancelled(token));
        this.drain();
      });
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

function cancelled(token: CancelToken): ToolResult {
  return { ok: false, status: "cancelled", error: token.reason || "cancelled" };
}
