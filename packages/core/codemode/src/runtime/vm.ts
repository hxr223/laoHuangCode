import { JSException, MAX_STACK_SIZE, QuickJS, type JSValueHandle } from "quickjs-wasi";
import { PRELUDE_SOURCE } from "./prelude-source.ts";
import type { HostToWorkerMessage, VmStartData, WorkerToHostMessage } from "./protocol.ts";
import type { CodeModeImageSource } from "../types.ts";

export interface VmSession {
  deliver(message: HostToWorkerMessage): void;
  dispose(): void;
}

export async function startVm(options: {
  data: VmStartData; wasm: object; post(message: WorkerToHostMessage): void; shouldInterrupt(): boolean;
}): Promise<VmSession> {
  const { data, post } = options;
  const vm = await QuickJS.create({ wasm: options.wasm, memoryLimit: data.memoryLimitBytes,
    maxStackSize: MAX_STACK_SIZE, interruptHandler: options.shouldInterrupt,
    wasi: (memory: { readonly buffer: ArrayBufferLike }) => ({ fd_write(_fd: number, pointer: number, count: number, writtenPointer: number) {
      const view = new DataView(memory.buffer);
      let written = 0;
      for (let index = 0; index < count; index++) written += view.getUint32(pointer + index * 8 + 4, true);
      view.setUint32(writtenPointer, written, true);
      return 0;
    } }),
  });
  let api: JSValueHandle;
  let settle: JSValueHandle;
  let stalled: JSValueHandle;
  let disposed = false;
  const exports = vm._getExports();
  const drain = () => {
    let jobs = 0;
    while (exports.qjs_is_job_pending()) {
      if (exports.qjs_execute_pending_job() < 0) throw new Error("Promise job failed");
      if (++jobs % 50 === 0 && options.shouldInterrupt()) throw new Error("Execution interrupted");
    }
    vm.callFunction(stalled, api).dispose();
  };
  const fail = (error: unknown) => {
    if (error instanceof JSException) post({ type: "done", ok: false, error: JSON.stringify({ name: error.name, message: error.message, stack: error.stack }) });
    else post({ type: "crash", message: error instanceof Error ? error.message : String(error) });
  };
  const session: VmSession = {
    deliver(message) {
      if (disposed) return;
      try {
        vm.withScope(() => {
          vm.callFunction(settle, api, vm.newNumber(message.id), message.ok ? vm.true : vm.false,
            message.payload === undefined ? vm.undefined : vm.newString(message.payload));
        });
        drain();
      } catch (error) { fail(error); }
    },
    dispose() { if (!disposed) { disposed = true; vm.dispose(); } },
  };
  try {
    const bridge = vm.newFunction("bridge", (kind, a, b, c) => {
      if (kind.toString() === "call" || kind.toString() === "global") post({ type: "call", target: kind.toString() === "call" ? "tool" : "global", id: a.toNumber(), name: b.toString(), args: c?.isUndefined ? undefined : c?.toString() });
      else if (kind.toString() === "output") post({ type: "output", item: { type: "text", text: a.toString(), ...(b?.toBoolean() ? { console: true } : {}) } });
      else if (kind.toString() === "image") post({ type: "output", item: { type: "image", ...JSON.parse(a.toString()) as CodeModeImageSource } });
      else if (kind.toString() === "done") {
        if (a.toBoolean()) post({ type: "done", ok: true, value: b?.isUndefined ? undefined : b?.toString(), writes: c.toString() });
        else post({ type: "done", ok: false, error: b.toString() });
      } else throw new Error("Invalid VM bridge operation");
      return vm.undefined;
    });
    api = vm.withScope(scope => scope.escape(vm.callFunction(vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"),
      vm.undefined, bridge, vm.newString(JSON.stringify(data.tools)), vm.newString(JSON.stringify(data.store)), vm.newString(JSON.stringify(data.globals)))));
    settle = api.getProp("settle");
    stalled = api.getProp("stalled");
    vm.withScope(() => {
      const fn = vm.evalCode(`(async (tools) => {${data.code}\n})`, "codemode.js");
      vm.callFunction(api.getProp("run"), api, fn);
    });
    drain();
  } catch (error) { fail(error); }
  return session;
}
