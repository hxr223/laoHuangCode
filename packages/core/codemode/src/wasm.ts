import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/** Opaque WebAssembly.Module; Node's type library excludes DOM globals. */
export type CodeModeWasmModule = object;
const modules = new Map<string, Promise<CodeModeWasmModule>>();

export function loadQuickJSWasm(path?: string): Promise<CodeModeWasmModule> {
  const resolved = path ?? createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm");
  let module = modules.get(resolved);
  if (!module) {
    const { WebAssembly } = globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<CodeModeWasmModule> } };
    module = readFile(resolved).then(bytes => WebAssembly.compile(bytes)).catch((error: unknown) => {
      modules.delete(resolved);
      throw error;
    });
    modules.set(resolved, module);
  }
  return module;
}
