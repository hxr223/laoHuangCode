import { Worker } from "node:worker_threads";
import type { CodeModeCall, CodeModeError, CodeModeExecuteOptions, CodeModeOutputItem, CodeModeResult, CodeModeSandboxOptions, CodeModeStoreWrites } from "../types.ts";
import { loadQuickJSWasm } from "../wasm.ts";
import { CODEMODE_LIMITS } from "../limits.ts";
import { mapCodeModeToolNames } from "../identifier.ts";
import { validateCodeModeGlobals } from "../globals.ts";
import { isNodeWatchMessage, isWorkerToHostMessage, type HostToWorkerMessage, type WorkerToHostMessage } from "./protocol.ts";

export class CodeModeSandbox {
  private readonly options: CodeModeSandboxOptions;
  private readonly active = new Set<() => void>();
  private readonly exits = new Set<Promise<void>>();
  private closed = false;

  constructor(options: CodeModeSandboxOptions = {}) {
    mapCodeModeToolNames(options.tools ?? []);
    validateCodeModeGlobals(options.globals ?? []);
    validateTimeout(options.timeoutMs);
    const memory = options.memoryLimitBytes ?? CODEMODE_LIMITS.memoryBytes;
    if (!Number.isSafeInteger(memory) || memory < 1 || memory > CODEMODE_LIMITS.memoryBytes) throw new RangeError("Invalid Code Mode memory limit");
    this.options = options;
  }

  execute(code: string, options: CodeModeExecuteOptions = {}): Promise<CodeModeResult> {
    if (this.closed) return Promise.reject(new Error("Code Mode sandbox is closed"));
    const timeout = options.timeoutMs ?? this.options.timeoutMs ?? Infinity;
    validateTimeout(timeout);
    const started = performance.now();
    const deadline = started + timeout;
    const calls: CodeModeCall[] = [];
    const output: CodeModeOutputItem[] = [];
    let outputChars = 0;
    const pending = new Map<number, AbortController>();
    let serializedStore: Readonly<Record<string, string>> = {};
    let worker: Worker | undefined;
    const interrupt = new Int32Array(new SharedArrayBuffer(4));
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    return new Promise<CodeModeResult>(resolve => {
      const finish = (outcome: { ok: true; value: unknown; storeWrites: CodeModeStoreWrites } | { ok: false; error: CodeModeError }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.active.delete(abort);
        options.signal?.removeEventListener("abort", abort);
        for (const controller of pending.values()) controller.abort();
        for (const call of calls) if (call.status === "running") call.status = "cancelled";
        Atomics.store(interrupt, 0, 1);
        if (worker) void worker.terminate().catch(() => {});
        resolve({ ...outcome, output: [...output], calls: calls.map(call => ({ ...call })), durationMs: performance.now() - started });
      };
      const fail = (kind: CodeModeError["kind"], error: unknown) => finish({ ok: false,
        error: { kind, message: error instanceof Error ? error.message : String(error) } });
      const abort = () => fail("aborted", options.signal?.reason ?? "Code Mode execution cancelled");
      const expired = () => {
        if (!done && performance.now() >= deadline) fail("timeout", `Code Mode timed out after ${timeout}ms`);
        return done;
      };
      const send = (message: HostToWorkerMessage) => { if (!expired()) worker?.postMessage(message); };
      const message = (value: unknown) => {
        if (expired()) return;
        if (isNodeWatchMessage(value)) return;
        if (!isWorkerToHostMessage(value)) { fail("sandbox", "Invalid worker protocol message"); return; }
        try {
          switch (value.type) {
            case "output": {
              const item = value.item;
              outputChars += item.type === "text" ? item.text.length : "data" in item ? item.data.length : item.attachment_id.length + (item.view ? JSON.stringify(item.view).length : 0);
              if (outputChars > CODEMODE_LIMITS.outputChars || output.length >= CODEMODE_LIMITS.outputItems) throw new Error("Worker output exceeded its limit");
              output.push(value.item); options.onOutput?.(value.item); break;
            }
            case "call": this.callTool(value, calls, pending, send); break;
            case "done": {
              if (value.ok) {
                const returned: unknown = value.value === undefined ? undefined : JSON.parse(value.value);
                const chars = typeof returned === "string" ? returned.length : value.value?.length ?? 0;
                if (outputChars + chars > CODEMODE_LIMITS.outputChars || returned !== undefined && output.length >= CODEMODE_LIMITS.outputItems) throw new Error("Worker return value exceeded its output limit");
                finish({ ok: true, value: returned, storeWrites: parseWrites(value.writes, serializedStore) });
              }
              else {
                const error = JSON.parse(value.error) as Record<string, unknown>;
                if (typeof error.message !== "string") throw new Error("Invalid script error");
                finish({ ok: false, error: { kind: "script", message: error.message,
                  ...(typeof error.name === "string" ? { name: error.name } : {}), ...(typeof error.stack === "string" ? { stack: error.stack } : {}) } });
              }
              break;
            }
            case "crash": fail("sandbox", value.message); break;
          }
        } catch (error) { fail("sandbox", error); }
      };
      this.active.add(abort);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      if (timeout !== Infinity) timer = setTimeout(() => fail("timeout", `Code Mode timed out after ${timeout}ms`), timeout);
      void (async () => {
        const store = Object.fromEntries(Object.entries(options.store ?? {}).map(([key, value]) => {
          const json = JSON.stringify(value);
          if (json === undefined) throw new TypeError("Initial store must be JSON serializable");
          if (json.length > CODEMODE_LIMITS.storeValueChars) throw new RangeError("Initial store value exceeded its JSON character limit");
          return [key, json];
        }));
        if (Object.entries(store).reduce((sum, [key, json]) => sum + key.length + json.length, 0) > CODEMODE_LIMITS.storeTotalChars) throw new RangeError("Initial store exceeded its total character limit");
        serializedStore = store;
        const wasm = await (this.options.wasm ?? loadQuickJSWasm());
        if (expired()) return;
        const release = this.options.acquireWorker?.();
        if (done) { release?.(); return; }
        try {
          worker = new Worker(this.options.workerUrl ?? new URL("./worker-entry.js", import.meta.url), { workerData: {
            code, store, memoryLimitBytes: this.options.memoryLimitBytes ?? CODEMODE_LIMITS.memoryBytes,
            globals: (this.options.globals ?? []).map(global => ({ name: global.name, spread: global.spread ?? false })),
            tools: mapCodeModeToolNames(this.options.tools ?? []), wasm, interrupt: interrupt.buffer,
          } });
        } catch (error) { release?.(); throw error; }
        const exited = new Promise<void>(exitResolve => {
          worker!.once("exit", exitCode => {
            release?.();
            exitResolve();
            if (!done) fail("sandbox", `Worker exited before a result (code ${exitCode})`);
          });
        });
        this.exits.add(exited);
        void exited.then(() => this.exits.delete(exited));
        worker.on("message", message);
        worker.on("error", error => fail("sandbox", error));
        this.options.onWorkerStarted?.(exited);
      })().catch(error => fail("sandbox", error));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.active) cancel();
  }

  async drain(): Promise<void> {
    await Promise.all(this.exits);
  }

  private callTool(message: Extract<WorkerToHostMessage, { type: "call" }>, calls: CodeModeCall[], pending: Map<number, AbortController>, send: (message: HostToWorkerMessage) => void): void {
    if (calls.some(call => call.id === message.id)) throw new Error("Duplicate tool call ID");
    const tool = (message.target === "tool" ? this.options.tools : this.options.globals)?.find(tool => tool.name === message.name);
    if (!tool) throw new Error(`Unknown tool: ${message.name}`);
    const args: unknown = message.args === undefined ? undefined : JSON.parse(message.args);
    const controller = new AbortController();
    pending.set(message.id, controller);
    const call: CodeModeCall = { id: message.id, name: message.name, status: "running", durationMs: 0 };
    calls.push(call);
    const started = performance.now();
    void Promise.resolve().then(() => tool.execute(args, { signal: controller.signal })).then(value => {
      const payload = JSON.stringify(value);
      if (!controller.signal.aborted) { call.status = "completed"; send({ type: "result", id: message.id, ok: true, payload }); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) { call.status = "failed"; send({ type: "result", id: message.id, ok: false, payload: error instanceof Error ? error.message : String(error) }); }
    }).finally(() => { call.durationMs = performance.now() - started; pending.delete(message.id); });
  }
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && timeout !== Infinity && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)) throw new RangeError("Invalid Code Mode timeout");
}

function parseWrites(json: string, initial: Readonly<Record<string, string>>): CodeModeStoreWrites {
  const entries: unknown = JSON.parse(json);
  if (!Array.isArray(entries)) throw new Error("Invalid store writes");
  const set: [string, unknown][] = [];
  const deleted: string[] = [];
  const keys = new Set<string>();
  const next = new Map(Object.entries(initial));
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 2 || typeof entry[0] !== "string" || keys.has(entry[0])) throw new Error("Invalid store write");
    keys.add(entry[0]);
    if (entry.length === 1) { deleted.push(entry[0]); next.delete(entry[0]); }
    else {
      if (typeof entry[1] !== "string") throw new Error("Invalid stored JSON");
      if (entry[1].length > CODEMODE_LIMITS.storeValueChars) throw new Error("Stored JSON exceeded its character limit");
      set.push([entry[0], JSON.parse(entry[1]) as unknown]);
      next.set(entry[0], entry[1]);
    }
  }
  if ([...next].reduce((sum, [key, value]) => sum + key.length + value.length, 0) > CODEMODE_LIMITS.storeTotalChars) throw new Error("Worker store exceeded its total character limit");
  return { set: Object.fromEntries(set), delete: deleted };
}
