import type { AttachmentContent } from "@laohuang/attachment";
import { CodeModeSandbox, parseCodeModeSource, type CodeModeTool } from "@laohuang/codemode";
import { stringArgument, withCodeModeMetadata, type ToolAdapterDefinition, type ToolExecutionContextLike, type ToolResult } from "@laohuang/tools";
import type { CodeModeImagePort } from "./images.ts";
import { renderCodeModeOutput } from "./output.ts";
import { toScriptToolValue } from "./value.ts";
import { scriptCallableSpecs, searchCodeModeTools } from "./discovery.ts";
import { CodeModeQueueError, CodeModeWorkerPool, type CodeModeWorkerLease } from "./worker-pool.ts";

export interface CodeModeSessionPorts {
  readonly readStore: () => Readonly<Record<string, unknown>>;
  readonly images: CodeModeImagePort;
  readonly outputDirectory: string;
}

export interface CodeModeToolOptions {
  readonly workerPool: CodeModeWorkerPool;
  readonly bindSession: (context: ToolExecutionContextLike) => CodeModeSessionPorts;
  readonly workerUrl?: string | URL;
  readonly wasm?: object | Promise<object>;
}

export interface ManagedCodeModeTool extends ToolAdapterDefinition {
  close(): Promise<void>;
}

export function createCodeModeTool(options: CodeModeToolOptions): ManagedCodeModeTool {
  const controllers = new Set<AbortController>();
  const sandboxes = new Set<CodeModeSandbox>();
  let closed = false;
  return {
    spec: { name: "codemode", description: "Execute JavaScript in an isolated QuickJS Worker. Call available host tools with await tools.name({...}). " +
      "Discover tools with await searchTools(query, limit?) or inspect ALL_TOOLS. Keep intermediate results in variables; use text(), image(), console or return to select model output. store()/load() retain small session state. " +
      "An optional first line // @options: {\"timeout_ms\":30000,\"max_output_tokens\":10000} sets script options. Default total timeout is unlimited.",
      parameters: { type: "object", properties: { code: { type: "string", description: "JavaScript source with top-level await and return." } }, required: ["code"], additionalProperties: false },
      promptGuidelines: [], exposure: "model-only", executionRole: "orchestrator" },
    async execute(args, context): Promise<ToolResult> {
      if (closed) return { ok: false, status: "cancelled", error: "Code Mode tool is closed" };
      const started = performance.now();
      const controller = new AbortController();
      controllers.add(controller);
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
      context.manageCancellation?.();
      let lease: CodeModeWorkerLease | undefined;
      let sandbox: CodeModeSandbox | undefined;
      try {
        signal.throwIfAborted();
        const parsed = parseCodeModeSource(stringArgument(args, "code"));
        const deadline = started + (parsed.options.timeoutMs ?? Infinity);
        const executeTool = context.executeTool?.bind(context);
        if (!executeTool || !context.callableTools) throw new Error("Code Mode requires a managed host tool execution context");
        const ports = options.bindSession(context);
        const internal = new Map<string, AttachmentContent>();
        const specs = scriptCallableSpecs(context.callableTools);
        const tools: CodeModeTool[] = specs.map(spec => ({
          name: spec.name, description: spec.description, inputSchema: spec.parameters, outputSchema: spec.outputSchema ?? { type: "string" },
          async execute(input, call) {
            const value = input === undefined ? {} : input;
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Host tool arguments must be a JSON object");
            const result = await executeTool(spec.name, value as Record<string, unknown>, { signal: call.signal });
            const attachments = result.attachmentContent ?? [];
            ports.images.remember(attachments);
            for (const attachment of attachments) if (attachment.type === "image" || !internal.has(attachment.ref.id)) internal.set(attachment.ref.id, attachment);
            return toScriptToolValue(spec, result);
          },
        }));
        lease = await options.workerPool.reserve({ signal, timeoutMs: deadline - performance.now(),
          onQueued: () => context.publish?.("tool.output_delta", { text: "Waiting for an available Code Mode Worker (queue limit: 60s).\n", stream: "stdout" }) });
        signal.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new CodeModeQueueError("timeout", "Code Mode deadline expired before starting the script");
        sandbox = new CodeModeSandbox({ tools, workerUrl: options.workerUrl, wasm: options.wasm, acquireWorker: lease.acquireWorker,
          globals: [{ name: "searchTools", spread: true, description: "Find script-callable tools and their input/output declarations.",
            inputSchema: { type: "array", prefixItems: [{ type: "string" }, { type: "integer", minimum: 1 }] }, outputSchema: { type: "string" },
            execute(input) {
              if (!Array.isArray(input) || typeof input[0] !== "string" || input[1] !== undefined && typeof input[1] !== "number") throw new TypeError("searchTools expects a query string and an optional positive integer limit");
              return searchCodeModeTools(specs, input[0], input[1]);
            },
          }] });
        sandboxes.add(sandbox);
        const result = await sandbox.execute(parsed.code, { signal, timeoutMs: remaining === Infinity ? Infinity : Math.ceil(remaining), store: ports.readStore(),
          onOutput: item => { if (item.type === "text") context.publish?.("tool.output_delta", { text: item.text + "\n", stream: "stdout" }); } });
        const rendered = await renderCodeModeOutput(result, { outputDirectory: ports.outputDirectory,
          // Finalizing already-emitted output must survive cancellation of script work.
          images: ports.images, maxOutputTokens: parsed.options.maxOutputTokens });
        if (signal.aborted) {
          rendered.ok = false;
          rendered.status = "cancelled";
          rendered.error = (signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "Code Mode execution cancelled")).slice(0, 4000);
        }
        return withCodeModeMetadata(rendered, {
          ...(result.ok && rendered.ok ? { storeWrites: result.storeWrites } : {}),
          internalAttachments: [...internal.values()],
        });
      } catch (error) {
        const cancelled = signal.aborted || error instanceof CodeModeQueueError && error.kind !== "timeout";
        return { ok: false, status: cancelled ? "cancelled" : error instanceof CodeModeQueueError ? "timeout" : "failed",
          error: (error instanceof Error ? error.message : String(error)).slice(0, 4000) };
      } finally {
        lease?.releaseUnused();
        controllers.delete(controller);
        if (sandbox) { sandboxes.delete(sandbox); await sandbox.close(); }
      }
    },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort(new Error("Code Mode tool is closed"));
      await Promise.all([...sandboxes].map(sandbox => sandbox.close()));
    },
  };
}
