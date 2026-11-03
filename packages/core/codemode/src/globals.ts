import type { CodeModeGlobal } from "./types.ts";

const RESERVED = new Set("tools ALL_TOOLS text image console exit store load process require fetch global globalThis await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield".split(" "));

export function validateCodeModeGlobals(globals: readonly CodeModeGlobal[]): void {
  const names = new Set<string>();
  const roots = new Map<string, boolean>();
  for (const global of globals) {
    const parts = global.name.split(".");
    const root = parts[0]!;
    const namespace = parts.length === 2;
    if (parts.length > 2 || parts.some(part => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) ||
      RESERVED.has(root) || root in globalThis || names.has(global.name) ||
      roots.has(root) && (!namespace || !roots.get(root)) || typeof global.execute !== "function") throw new Error(`Invalid or conflicting Code Mode global: ${global.name}`);
    names.add(global.name);
    roots.set(root, namespace);
  }
}
