import { createRequire } from "node:module";
import type Koffi from "koffi";
import type { KoffiFunc } from "koffi";

export interface WindowsConsole {
  getMode(): number;
  setMode(mode: number): void;
  shiftPressed(): boolean;
}

export interface RawModeInput {
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

const require = createRequire(import.meta.url);
let native: WindowsConsole | null | undefined;
const activeConsoles: WindowsConsole[] = [];

/** A pipe (including mintty) is not a Win32 console and already carries VT bytes. */
export function getWindowsConsole(): WindowsConsole | null {
  if (process.platform !== "win32") return null;
  if (native !== undefined) return native;
  // Lazy loading keeps Unix and non-interactive CLI startup free of native code.
  const koffi = require("koffi") as typeof Koffi;
  const kernel = koffi.load("kernel32.dll");
  const user = koffi.load("user32.dll");
  const getHandle = kernel.func("__stdcall", "GetStdHandle", "void *", ["uint32_t"]) as KoffiFunc<(id: number) => bigint | null>;
  const getMode = kernel.func("__stdcall", "GetConsoleMode", "int", ["void *", "void *"]) as KoffiFunc<(handle: bigint | null, buffer: Buffer) => number>;
  const setMode = kernel.func("__stdcall", "SetConsoleMode", "int", ["void *", "uint32_t"]) as KoffiFunc<(handle: bigint | null, mode: number) => number>;
  const getKey = user.func("__stdcall", "GetAsyncKeyState", "int16_t", ["int"]) as KoffiFunc<(key: number) => number>;
  const getError = kernel.func("__stdcall", "GetLastError", "uint32_t", []) as KoffiFunc<() => number>;
  const handle = getHandle(0xfffffff6); // STD_INPUT_HANDLE (-10 as DWORD).
  const buffer = Buffer.alloc(4);
  if (!getMode(handle, buffer)) return native = null;
  native = {
    getMode: () => {
      if (!getMode(handle, buffer)) throw new Error(`GetConsoleMode failed (${getError()})`);
      return buffer.readUInt32LE();
    },
    setMode: (mode) => {
      if (!setMode(handle, mode)) throw new Error(`SetConsoleMode failed (${getError()})`);
    },
    shiftPressed: () => (getKey(0x10) & 0x8000) !== 0,
  };
  return native;
}

export function isLocalWindowsConsole(): boolean {
  return process.platform === "win32" && activeConsoles.length > 0 &&
    !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY;
}

export function isNativeShiftPressed(): boolean {
  return isLocalWindowsConsole() && (activeConsoles.at(-1)?.shiftPressed() ?? false);
}

/** Save modes before libuv changes them; enable VT after raw mode resets flags. */
export function enterTerminalRawMode(
  input: RawModeInput,
  console: WindowsConsole | null = input === process.stdin ? getWindowsConsole() : null,
): () => void {
  if (!input.setRawMode) return () => {};
  const wasRaw = input.isRaw ?? false;
  const originalMode = console?.getMode();
  let active = true;
  let registered = false;
  const restore = (): void => {
    if (!active) return;
    active = false;
    if (registered && console) activeConsoles.splice(activeConsoles.lastIndexOf(console), 1);
    try {
      input.setRawMode?.(wasRaw);
    } finally {
      if (originalMode !== undefined) console?.setMode(originalMode);
    }
  };
  try {
    input.setRawMode(true);
    if (console) {
      console.setMode(console.getMode() | 0x200);
      activeConsoles.push(console);
      registered = true;
    }
    return restore;
  } catch (error) {
    try {
      restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Terminal setup and mode restoration failed");
    }
    throw error;
  }
}
