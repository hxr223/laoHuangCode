import assert from "node:assert/strict";
import test from "node:test";
import { enterTerminalRawMode, getWindowsConsole } from "../packages/terminal/tui/src/tui/native-console.ts";
import { TerminalInputFilter } from "../packages/terminal/tui/src/tui/editor.ts";

test("VT input is enabled after raw mode and the exact original mode is restored", () => {
  let mode = 0x17;
  const rawChanges: boolean[] = [];
  const input = { isRaw: true, setRawMode: (raw: boolean) => { rawChanges.push(raw); mode = 0x80; } };
  const native = { getMode: () => mode, setMode: (value: number) => { mode = value; }, shiftPressed: () => false };
  const restore = enterTerminalRawMode(input, native);
  assert.equal(mode, 0x280);
  restore();
  restore();
  assert.deepEqual(rawChanges, [true, true]);
  assert.equal(mode, 0x17);
});

test("failed VT setup rolls raw and native console modes back", () => {
  let mode = 7;
  let raw = false;
  const input = { isRaw: false, setRawMode: (value: boolean) => { raw = value; mode = 0; } };
  const native = { getMode: () => mode, setMode: (value: number) => {
    if (value & 0x200) throw new Error("VT unavailable");
    mode = value;
  }, shiftPressed: () => false };
  assert.throws(() => enterTerminalRawMode(input, native), /VT unavailable/);
  assert.equal(raw, false);
  assert.equal(mode, 7);
});

test("Windows Shift+Enter fallback does not override explicit protocol keys", () => {
  const filter = new TerminalInputFilter({ isWindowsConsole: () => true, shiftPressed: () => true });
  assert.equal(filter.feed(Buffer.from("\r"))[0]!.toString(), "\x1b[13;2u");
  for (const sequence of ["\x1b[13;1u", "\x1b[Z", "\x1b\r", "text"]) {
    assert.equal(filter.feed(Buffer.from(sequence))[0]!.toString(), sequence);
  }
  const remote = new TerminalInputFilter({ isAppleTerminal: () => false, isWindowsConsole: () => false, shiftPressed: () => true });
  assert.equal(remote.feed(Buffer.from("\r"))[0]!.toString(), "\r");
});

test("Windows native helper loads with prebuilt dependencies", { skip: process.platform !== "win32" }, () => {
  // CI pipes are not console handles; loading/binding must still succeed.
  const native = getWindowsConsole();
  if (native !== null) {
    assert.equal(typeof native.getMode(), "number");
    assert.equal(typeof native.shiftPressed(), "boolean");
  }
});
