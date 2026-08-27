import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryTerminalDriver,
  PiMainScreenRenderer,
  truncateToWidth,
  visibleWidth,
  wrapTextToWidth,
  type ScreenFrame,
} from "../packages/terminal/tui/src/tui/screen.ts";
import { TerminalEmulator } from "./helpers/terminal-emulator.ts";

function frame(
  lines: string[],
  activeStart: number,
  cursorRow: number,
  cursorCol = 0,
): ScreenFrame {
  return { lines, activeStart, cursorRow, cursorCol };
}

function stripControlsForAssertion(text: string): string {
  return text.replaceAll("\x1b[31m", "").replaceAll("\x1b[0m", "");
}

test("emulator scrolls when linefeed writes at bottom row", () => {
  const terminal = new TerminalEmulator({ columns: 10, rows: 2 });

  terminal.write("top\r\nbottom\r\nnext");

  assert.deepEqual(terminal.scrollback, ["top"]);
  assert.deepEqual(terminal.viewportLines, ["bottom", "next"]);
  assert.equal(terminal.cursorRow, 1);
  assert.equal(terminal.cursorColumn, 4);
  assert.equal(terminal.viewportTop, 1);
});

test("emulator wraps only after next printable full width line", () => {
  const terminal = new TerminalEmulator({ columns: 4, rows: 3 });

  terminal.write("abcd");

  assert.deepEqual(terminal.viewportLines, ["abcd", "", ""]);
  assert.equal(terminal.cursorRow, 0);
  assert.equal(terminal.cursorColumn, 3);

  terminal.write("X");

  assert.deepEqual(terminal.viewportLines, ["abcd", "X", ""]);
  assert.equal(terminal.cursorRow, 1);
  assert.equal(terminal.cursorColumn, 1);
});

test("new completed lines append without erasing scrollback", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);

  renderer.render(frame(["user one", "answer one", "❯ "], 2, 2));
  terminal.clearWrites();
  renderer.render(frame(["user one", "answer one", "user two", "❯ "], 3, 2));

  assert.ok(terminal.writes().includes("user two"));
  assert.ok(terminal.writes().includes("\x1b[2K"));
  assert.ok(!terminal.writes().includes("\x1b[2J"));
  assert.ok(!terminal.writes().includes("\x1b[3J"));
});

test("stream delta repaints only changed active tail", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["user one", "answer one", "answer two: hel", "❯ "], 3, 2));
  terminal.clearWrites();

  renderer.render(frame(["user one", "answer one", "answer two: hello", "❯ "], 3, 2));

  assert.ok(terminal.writes().includes("\x1b[2K"));
  assert.ok(terminal.writes().includes("answer two: hello"));
  assert.ok(!terminal.writes().includes("answer one"));
});

test("completed active line is rewritten in place without duplication", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["user", "answer: hel", "❯ "], 1, 2));
  terminal.clearWrites();

  renderer.render(frame(["user", "answer: hello", "❯ "], 2, 2));

  assert.ok(terminal.writes().includes("\x1b[2Kanswer: hello"));
  assert.equal(terminal.writes().split("answer: hello").length - 1, 1);
  assert.ok(!terminal.writes().includes("\x1b[2J"));
  assert.ok(!terminal.writes().includes("\x1b[3J"));
});

test("cursor column is positioned within the selected line", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["history", "❯ edit"], 1, 1, 0));
  terminal.clearWrites();

  renderer.render(frame(["history", "❯ edit"], 1, 1, 4));

  assert.ok(terminal.writes().includes("\x1b[5G"));
});

test("cursor column uses terminal cells not string length", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);

  renderer.render(frame(["❯ 你好你"], 0, 0, 8));

  assert.ok(terminal.writes().includes("\x1b[9G"));
  assert.ok(!terminal.writes().includes("\x1b[6G"));
});

test("render emits one atomic terminal write", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["─".repeat(80), "❯ a", "─".repeat(80)], 1, 1, 3));
  terminal.clearWrites();

  renderer.render(frame(["─".repeat(80), "❯ as", "─".repeat(80)], 1, 1, 4));

  assert.equal(terminal.writeChunks().length, 1);
  assert.ok(terminal.writes().includes("\x1b[2K❯ as"));
});

test("diff render uses synchronized output wrappers", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["one", "❯ a"], 1, 1, 3));
  terminal.clearWrites();

  renderer.render(frame(["one", "❯ as"], 1, 1, 4));

  assert.ok(terminal.writes().startsWith("\x1b[?2026h"));
  assert.ok(terminal.writes().includes("\x1b[?2026l"));
});

test("editor only change does not repaint unchanged footer rows", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 4 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["─".repeat(80), "❯ a", "─".repeat(80)], 1, 1, 3));
  terminal.clearWrites();

  renderer.render(frame(["─".repeat(80), "❯ as", "─".repeat(80)], 1, 1, 4));

  assert.equal(terminal.writes().split("\x1b[2K").length - 1, 1);
  assert.ok(!terminal.writes().includes("\r\n"));
  assert.ok(!terminal.writes().includes("─".repeat(80)));
});

test("unframed editor updates do not duplicate prompts semantically", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 4 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 4 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["❯ a"], 0, 0, 3));
  emulator.write(terminal.writes());
  terminal.clearWrites();

  renderer.render(frame(["❯ as"], 0, 0, 4));
  emulator.write(terminal.writes());

  const rendered = emulator.logicalLines.join("\n");
  assert.equal(rendered.split("❯ ").length - 1, 1);
  assert.equal(emulator.viewportLines[0], "❯ as");
  assert.ok(!emulator.logicalLines.includes("❯ a"));
});

test("changed line above previous viewport uses full render", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 2 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["old", "middle", "tail", "❯ "], 3, 3));
  terminal.clearWrites();

  renderer.render(frame(["new", "middle", "tail", "❯ "], 3, 3));

  assert.ok(terminal.writes().includes("\x1b[2J\x1b[H\x1b[3J"));
  assert.ok(terminal.writes().includes("new"));
});

test("cursor only update flushes terminal output", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["one", "two"], 1, 1));
  const flushesBefore = terminal.flushes;

  renderer.render(frame(["one", "two"], 1, 0));

  assert.equal(terminal.flushes, flushesBefore + 1);
});

test("resize uses pi full render clear path", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.render(frame(["saved history", "active", "❯ "], 2, 2));
  terminal.resize({ columns: 40, rows: 24 });
  terminal.clearWrites();

  renderer.render(frame(["saved history", "active", "❯ "], 2, 2));

  assert.ok(terminal.writes().includes("\x1b[2J\x1b[H\x1b[3J"));
  assert.ok(terminal.writes().includes("saved history"));
  assert.ok(!terminal.writes().includes("\x1b[2K"));
});

test("over width line raises before writing", () => {
  const terminal = new MemoryTerminalDriver({ columns: 4, rows: 2 });
  const renderer = new PiMainScreenRenderer(terminal);

  assert.throws(
    () => renderer.render(frame(["12345"], 0, 0)),
    /exceeds terminal width/,
  );

  assert.equal(terminal.writes(), "");
});

test("embedded physical newline raises before writing", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 2 });
  const renderer = new PiMainScreenRenderer(terminal);

  assert.throws(
    () => renderer.render(frame(["thinking\nleaked"], 0, 0)),
    /contains a physical newline/,
  );

  assert.equal(terminal.writes(), "");
});

test("visible width ignores ansi and terminal controls", () => {
  const styled = "\x1b[31m你好\x1b[0m";
  const linked = "\x1b]8;;https://example.test\x1b\\abc\x1b]8;;\x1b\\";
  const apc = "\x1b_pi:c\x07";
  const apcThenText = "\x1b_pi:c\x07abc";

  assert.equal(visibleWidth(styled), 4);
  assert.equal(visibleWidth(linked), 3);
  assert.equal(visibleWidth(apc), 0);
  assert.equal(visibleWidth(apcThenText), 3);
});

test("truncate and wrap use visible cells", () => {
  const styled = "\x1b[31m你好abc\x1b[0m";

  assert.equal(visibleWidth(truncateToWidth(styled, 5)), 5);
  assert.deepEqual(wrapTextToWidth("你好abc", 4), ["你好", "abc"]);
});

test("truncate closes open sgr style", () => {
  assert.equal(truncateToWidth("\x1b[31mabcdef\x1b[0m", 5), "\x1b[31mabcde\x1b[0m");
});

test("wrap preserves sgr without splitting escape sequences", () => {
  const wrapped = wrapTextToWidth("\x1b[31mabcdef\x1b[0m", 5);

  assert.deepEqual(wrapped, ["\x1b[31mabcde\x1b[0m", "\x1b[31mf\x1b[0m"]);
  assert.deepEqual(
    wrapped.map((line) => visibleWidth(line)),
    [5, 1],
  );
  assert.ok(!stripControlsForAssertion(wrapped.join("\n")).includes("[0m"));
});

test("vs16 emoji uses two terminal cells", () => {
  assert.equal(visibleWidth("❤️"), 2);
  assert.equal(visibleWidth("✈️"), 2);
});

test("truncate and wrap expand tabs consistently", () => {
  const truncated = truncateToWidth("a\tb", 4);
  const wrapped = wrapTextToWidth("a\tb", 4);

  assert.equal(truncated, "a   ");
  assert.deepEqual(wrapped, ["a   ", "b"]);
  assert.equal(visibleWidth(truncated), 4);
  assert.ok(wrapped.every((line) => visibleWidth(line) <= 4));
});

test("osc8 visible text counts toward width", () => {
  const terminal = new MemoryTerminalDriver({ columns: 4, rows: 2 });
  const renderer = new PiMainScreenRenderer(terminal);
  const linked = "\x1b]8;;https://example.test\x1b\\12345\x1b]8;;\x1b\\";

  assert.throws(
    () => renderer.render(frame([linked], 0, 0)),
    /exceeds terminal width/,
  );

  assert.equal(terminal.writes(), "");
});

test("zwj emoji cluster uses terminal cell width", () => {
  const terminal = new MemoryTerminalDriver({ columns: 2, rows: 2 });
  const renderer = new PiMainScreenRenderer(terminal);

  renderer.render(frame(["👨‍👩‍👧‍👦"], 0, 0));

  assert.ok(terminal.writes().includes("👨‍👩‍👧‍👦"));
});

test("flag emoji cluster uses terminal cell width", () => {
  const terminal = new MemoryTerminalDriver({ columns: 2, rows: 2 });
  const renderer = new PiMainScreenRenderer(terminal);

  renderer.render(frame(["🇨🇳"], 0, 0));

  assert.ok(terminal.writes().includes("🇨🇳"));
});

test("close restores driver and cursor", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);
  renderer.close();

  assert.equal(terminal.restored, true);
  assert.ok(terminal.writes().includes("\x1b[0 q"));
  assert.ok(terminal.writes().includes("\x1b[?25h"));
  renderer.close();
  assert.equal(terminal.restoreCalls, 1);
});

test("close restores driver when cursor write fails", () => {
  class BrokenWriteTerminal extends MemoryTerminalDriver {
    override write(_data: string): void {
      throw new Error("closed");
    }
  }

  const terminal = new BrokenWriteTerminal({ columns: 80, rows: 24 });
  const renderer = new PiMainScreenRenderer(terminal);

  assert.throws(() => renderer.close(), /closed/);

  assert.equal(terminal.restored, true);
});
