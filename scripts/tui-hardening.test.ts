import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync, statSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import xterm from "@xterm/headless";
import { compileStyledLines } from "../packages/terminal/tui/src/tui/ansi-renderer.ts";
import { EditorState, InputActionKind, inputAction } from "../packages/terminal/tui/src/tui/editor.ts";
import { renderMarkdownStyledLines } from "../packages/terminal/tui/src/tui/markdown.ts";
import { line, span, lineText, wrapStyledSpans, truncateStyledLine } from "../packages/terminal/tui/src/tui/render-model.ts";
import { MainScreenRenderer, MemoryTerminalDriver } from "../packages/terminal/tui/src/tui/screen.ts";
import { DEFAULT_DARK_THEME } from "../packages/terminal/tui/src/tui/theme.ts";
import { normalizeTerminalOutput, sliceByColumn, stripTerminalControls, visibleWidth, wrapTextToWidth, truncateToWidth } from "../packages/terminal/tui/src/tui/terminal-text.ts";
import { TerminalInputDecoder } from "../packages/terminal/tui/src/tui/terminal-input-decoder.ts";
import { drainTerminalInput, inputTimeout } from "../packages/terminal/tui/src/tui/terminal-session.ts";
import { OverlayManager } from "../packages/terminal/tui/src/tui/overlay-manager.ts";
import { BoundedTerminalWriter } from "../packages/terminal/tui/src/tui/terminal-writer.ts";
import { RenderWidthError, recordRenderFailure } from "../packages/terminal/tui/src/tui/render-diagnostics.ts";
import { Text } from "../packages/terminal/tui/src/tui/components/primitives/text.ts";
import { Box } from "../packages/terminal/tui/src/tui/components/primitives/box.ts";
import { TerminalUI } from "../packages/terminal/tui/src/tui/ui.ts";
import { TerminalInputSession } from "../packages/terminal/tui/src/tui/input.ts";

const theme = DEFAULT_DARK_THEME;
const render = (text: string, width: number) => compileStyledLines(renderMarkdownStyledLines(text, width), width, theme);
const printable = (lines: readonly string[]) => lines.map(stripTerminalControls).join("");

test("streamed emoji and style boundaries use the same widths throughout layout", () => {
  for (const text of ["⚠️", "👩🏽‍💻", "🇨🇳", "e\u0301", "1️⃣", "क्ष", "กำ", "Ａ"]) {
    for (let end = 1; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      for (const width of [1, 2, 3, 7, 212]) {
        const rows = wrapStyledSpans([span(prefix), span("a".repeat(211), { bold: true })], width);
        const compiled = compileStyledLines(rows, width, theme);
        assert.ok(compiled.every(row => visibleWidth(row) <= width), `${JSON.stringify(prefix)} at ${width}`);
        assert.ok(render(prefix + "a".repeat(211), width).every(row => visibleWidth(row) <= width));
      }
    }
    for (let split = 0; split <= text.length; split++) {
      const spans = [span(text.slice(0, split)), span(text.slice(split) + "abc", { bold: true })];
      const rows = compileStyledLines(wrapStyledSpans(spans, 4), 4, theme);
      assert.equal(printable(rows), printable(wrapTextToWidth(text + "abc", 4)));
      assert.ok(visibleWidth(compileStyledLines([truncateStyledLine(line(...spans), 2, "")], 2, theme)[0]!) <= 2);
    }
  }
  const raw = "⚠\x1b[31m️" + "a".repeat(211);
  assert.deepEqual(wrapTextToWidth(raw, 212).map(visibleWidth), [212, 1]);
  assert.equal(visibleWidth(truncateToWidth(raw, 212)), 212);
  assert.deepEqual(render("⚠️" + "a".repeat(211), 212).map(visibleWidth), [212, 1]);
  assert.equal(visibleWidth("\ud83d"), 1, "UTF-8 output replaces an incomplete surrogate with one visible cell");
  assert.equal(normalizeTerminalOutput("\ud83d"), "�");
});

test("narrow layouts keep content and replace only glyphs that cannot fit", () => {
  assert.deepEqual(wrapTextToWidth("中a", 1), ["�", "a"]);
  assert.equal(printable(render("- abc", 1)), "abc");
  for (const width of [1, 2, 3]) {
    const component = new Box({ paddingX: 3, child: new Text({ text: "abc", paddingX: 2 }) });
    const lines = component.render({ width, theme }).lines;
    assert.equal(lines.map(lineText).join("").replace(/ /g, ""), "abc");
    assert.ok(compileStyledLines(lines, width, theme).every(value => visibleWidth(value) <= width));
  }
});

test("empty editor places its caret after the visible prompt at every width", () => {
  const editor = new EditorState();
  for (const [width, expectedColumn] of [[1, 0], [2, 1], [3, 2], [80, 2]] as const) {
    for (const mask of [false, true]) {
      const frame = editor.renderLines(width, { prompt: "> ", mask });
      assert.equal(frame.cursorRow, 0);
      assert.equal(frame.cursorColumn, expectedColumn, `width=${width}, mask=${mask}`);
    }
  }
});

test("terminal caret stays after the prompt on startup, deletion and submission", async (t) => {
  const terminal = new xterm.Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  const driver = new MemoryTerminalDriver({ columns: 40, rows: 12 });
  const ui = new TerminalUI({ driver, theme: "dark" });
  const submitted: string[] = [];
  t.after(() => { ui.close(); terminal.dispose(); });
  ui.startLoop(text => { submitted.push(text); });
  const paint = async (input = "") => {
    if (input) ui.feedInputBytes(Buffer.from(input));
    ui.drainLoop();
    const output = driver.writes();
    driver.clearWrites();
    await new Promise<void>(resolve => terminal.write(output, resolve));
  };
  const assertEmptyCaret = () => {
    const buffer = terminal.buffer.active;
    assert.ok(buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(true).startsWith("│> "));
    assert.equal(buffer.cursorX, 3, "caret must follow the border and two-cell prompt");
  };

  await paint();
  assertEmptyCaret();
  await paint("a");
  assert.equal(terminal.buffer.active.cursorX, 4);
  await paint("\x7f");
  assertEmptyCaret();
  await paint("hello\r");
  assert.deepEqual(submitted, ["hello"]);
  assertEmptyCaret();
});

test("editor movement, deletion, masking and caret share grapheme boundaries", () => {
  const editor = new EditorState();
  editor.text = "a👩🏽‍💻e\u0301中";
  editor.cursor = editor.text.length;
  const apply = (kind: typeof InputActionKind[keyof typeof InputActionKind]) => editor.apply(inputAction(kind), { runtimeActive: false });
  apply(InputActionKind.CursorLeft);
  assert.equal(editor.text.slice(editor.cursor), "中");
  apply(InputActionKind.Backspace);
  assert.equal(editor.text, "a👩🏽‍💻中");
  apply(InputActionKind.CursorLeft);
  assert.equal(editor.cursor, 1);
  apply(InputActionKind.CursorRight);
  assert.equal(editor.text.slice(editor.cursor), "中");
  for (const width of [1, 2, 3, 4, 8, 20]) {
    for (const mask of [true, false]) {
      const frame = editor.renderLines(width, { mask });
      assert.ok(frame.lines.every(value => visibleWidth(value) <= width));
      assert.ok(frame.cursorColumn >= 0 && frame.cursorColumn < width);
      assert.ok(frame.cursorRow >= 0 && frame.cursorRow < frame.lines.length);
      if (mask) assert.equal(frame.lines.join("").includes("👩"), false);
    }
  }
  editor.text = "\x1b[31mab";
  editor.cursor = editor.text.length;
  assert.equal(editor.renderLines(30, { prompt: "" }).lines[0], "␛[31mab");
});

test("UTF-8 and terminal protocol sequences survive every byte boundary", () => {
  const text = "汉字👩🏽‍💻e\u0301";
  const bytes = Buffer.from(text);
  for (let split = 1; split < bytes.length; split++) {
    const decoder = new TerminalInputDecoder({ enableModifyOtherKeys() {}, disableModifyOtherKeys() {} });
    const actions = [...decoder.feed(bytes.subarray(0, split)), ...decoder.feed(bytes.subarray(split)), ...decoder.flush()];
    assert.equal(actions.map(action => action.text).join(""), text);
  }
  const decoder = new TerminalInputDecoder({ enableModifyOtherKeys() {}, disableModifyOtherKeys() {} });
  const actions = [...Buffer.from(text)].flatMap(byte => decoder.feed(Buffer.from([byte])));
  assert.equal(actions.map(action => action.text).join(""), text);
  for (const sequence of ["\x1b]52;c;ignored\x07", "\x1bPignored\x1b\\", "\x1b_ignored\x1b\\", "\x1b[97;1:3u"]) {
    const actions = [...Buffer.from(sequence)].flatMap(byte => decoder.feed(Buffer.from([byte])));
    assert.deepEqual(actions, []);
    assert.equal(decoder.pendingKind(), "none");
  }
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[200~one\ntwo")), []);
  assert.equal(decoder.pendingKind(), "paste");
  assert.deepEqual(decoder.flush(), []);
  assert.equal(decoder.feed(Buffer.from("\x1b[201~"))[0]?.text, "one\ntwo");
});

test("Escape timeout distinguishes local keys, SSH, partial sequences and paste", () => {
  assert.equal(inputTimeout("escape", {}), 10);
  assert.equal(inputTimeout("escape", { SSH_TTY: "/dev/pts/0" }), 100);
  assert.equal(inputTimeout("escape", { LAOHUANG_ESC_TIMEOUT: "250" }), 250);
  assert.equal(inputTimeout("escape", { LAOHUANG_ESC_TIMEOUT: "bad" }), 10);
  assert.equal(inputTimeout("sequence", {}), 50);
  assert.equal(inputTimeout("negotiation", {}), 150);
  assert.equal(inputTimeout("paste", {}), null);
  assert.equal(inputTimeout("none", {}), null);
});

test("real terminal cells preserve CJK boundaries and isolate SGR between rows", async (t) => {
  const terminal = new xterm.Terminal({ cols: 12, rows: 4, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const row = normalizeTerminalOutput("\x1b[31;44m中文");
  await new Promise<void>(resolve => terminal.write(row + "\r\nplain", resolve));
  const first = terminal.buffer.active.getLine(0)!;
  assert.equal(first.getCell(0)!.getWidth(), 2);
  assert.equal(first.getCell(1)!.getWidth(), 0);
  assert.equal(first.getCell(2)!.getChars(), "文");
  assert.equal(first.getCell(0)!.isFgDefault(), false);
  const next = terminal.buffer.active.getLine(1)!.getCell(0)!;
  assert.equal(next.isFgDefault(), true);
  assert.equal(next.isBgDefault(), true);
  assert.equal(printable([sliceByColumn(row, 1, 2)]), "  ");
  assert.equal(printable([sliceByColumn(row, 2, 3)]), "文 ");
});

test("hyperlinks close at row and clipping boundaries with a readable fallback", () => {
  const raw = "\x1b]8;;https://example.com\x07hello";
  for (const row of wrapTextToWidth(raw, 2)) {
    assert.ok(row.includes("\x1b]8;;https://example.com\x07"));
    assert.ok(row.endsWith("\x1b]8;;\x07"));
  }
  assert.equal(printable([truncateToWidth(raw, 3)]), "hel");
  const previous = process.env.LAOHUANG_HYPERLINKS;
  try {
    process.env.LAOHUANG_HYPERLINKS = "1";
    assert.match(render("[docs](https://example.com)", 80).join(""), /\x1b\]8;;https:\/\/example.com/);
    process.env.LAOHUANG_HYPERLINKS = "0";
    assert.match(printable(render("[docs](https://example.com)", 80)), /https:\/\/example.com/);
  } finally {
    if (previous === undefined) delete process.env.LAOHUANG_HYPERLINKS;
    else process.env.LAOHUANG_HYPERLINKS = previous;
  }
});

test("floating overlays clip wide cells, restore focus and react to viewport visibility", () => {
  const overlays = new OverlayManager();
  const component = { focused: false, invalidate() {}, render() { return { lines: [line(span("X", { bold: true }))], cursor: { row: 0, column: 0 } }; } };
  overlays.setViewport(8, 3);
  overlays.open({ id: "float", priority: "modal", placement: "floating", component, options: { width: 1, row: 0, column: 1, visible: width => width >= 4 } });
  const base = { lines: ["中文abcd"], activeStart: 1, cursorRow: 0, cursorCol: 0 };
  const composed = overlays.composite(base, theme);
  assert.equal(stripTerminalControls(composed.lines[0]!), " X文abcd");
  assert.equal(composed.cursorCol, 1);
  assert.equal(composed.activeStart, 0);
  assert.equal(component.focused, true);
  overlays.setHidden("float", true);
  assert.equal(overlays.top(), null);
  assert.deepEqual(overlays.composite(base, theme), base);
  overlays.setHidden("float", false);
  assert.equal(component.focused, true);
  overlays.setViewport(3, 3);
  assert.equal(component.focused, false);
  overlays.setViewport(8, 3);
  overlays.close("float");
  assert.equal(component.focused, false);
});

test("floating selection is composed by the live UI and accepts keyboard input", async (t) => {
  const driver = new MemoryTerminalDriver({ columns: 40, rows: 12 });
  const ui = new TerminalUI({ driver, theme: "dark" });
  t.after(() => ui.close());
  ui.startLoop(() => {});
  const selection = ui.interactiveLoop!.openSelection({ id: "floating", title: "Choose", items: [{ value: "yes", label: "Yes" }], floating: { width: "50%", maxHeight: 8 } });
  ui.drainLoop();
  assert.equal(ui.renderError, null);
  assert.equal(ui.interactiveLoop!.focusedComponentId(), "floating");
  assert.match(stripTerminalControls(driver.writes()), /Choose/);
  ui.feedInputBytes(Buffer.from("\r"));
  ui.drainLoop();
  assert.equal(await selection, "yes");
  assert.equal(ui.interactiveLoop!.focusedComponentId(), "composer");
});

test("bounded writes preserve surrogate pairs and complete synchronized frames", () => {
  const chunks: string[] = [];
  const writer = new BoundedTerminalWriter(value => chunks.push(value));
  const text = "a".repeat(BoundedTerminalWriter.MAX_CHARS - 1) + "👩" + "b".repeat(BoundedTerminalWriter.MAX_CHARS);
  writer.append(text);
  writer.flush();
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every(value => value.length <= BoundedTerminalWriter.MAX_CHARS && value.isWellFormed()));
  const driver = new MemoryTerminalDriver({ columns: 400, rows: 12 });
  const renderer = new MainScreenRenderer(driver);
  renderer.render({ lines: Array.from({ length: 3000 }, () => "x".repeat(399)), activeStart: 3000, cursorRow: 2999, cursorCol: 0 });
  assert.ok(driver.writeChunks().every(value => value.length <= BoundedTerminalWriter.MAX_CHARS));
  assert.ok(driver.writes().includes("\x1b[?2026h"));
  assert.ok(driver.writes().includes("\x1b[?2026l"));
  renderer.close();
  assert.equal(driver.restoreCalls, 1);
});

test("shutdown drains late reports before restoring the terminal", async () => {
  const input = new EventEmitter();
  const drained = drainTerminalInput(input, 200, 20);
  input.emit("data", Buffer.from("\x1b[?1u"));
  assert.equal(input.listenerCount("data"), 1);
  await drained;
  assert.equal(input.listenerCount("data"), 0);
});

test("width diagnostics retain a bounded escaped row in a private file", () => {
  const error = new RenderWidthError(80, 9000, "\x1b[31m" + "x".repeat(9000), "screen row 3");
  assert.equal(recordRenderFailure(error), error);
  const path = error.message.split("; diagnostic: ")[1]!;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(data.renderedLine.length, 4096);
    assert.equal(data.source, "screen row 3");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dirname(path), { recursive: true }); }
});

test("abandoned escape replies do not capture later keystrokes", () => {
  for (const partial of ["\x1b]52;c;partial", "\x1bPpartial", "\x1bO", "\x1b[1;"]) {
    const decoder = new TerminalInputDecoder({ enableModifyOtherKeys() {}, disableModifyOtherKeys() {} });
    assert.deepEqual(decoder.feed(Buffer.from(partial)), []);
    assert.deepEqual(decoder.flush(), []);
    assert.equal(decoder.feed(Buffer.from("abc")).map(action => action.text).join(""), "abc");
  }
});

test("queued runtime output cannot postpone the next input update", async (t) => {
  const driver = new MemoryTerminalDriver({ columns: 60, rows: 12 });
  const editor = new EditorState();
  const ui = new TerminalUI({ driver, editorFactory: () => editor });
  const input = new EventEmitter();
  const loop = ui.interactiveLoop!;
  loop.start(() => {});
  const done = loop.run(input);
  t.after(async () => { ui.requestExit(); await done; });
  for (let index = 0; index < 1000; index++) {
    ui.publishEvent({ kind: "model.text_delta", correlation_id: "stream", payload: { text: "a" } });
  }
  input.emit("data", Buffer.from("汉字"));
  assert.equal(editor.text, "汉字");
  assert.equal(ui.renderError, null);
  let cancelled = false;
  ui.setCancelCallback(() => { cancelled = true; });
  ui.publishEvent({ kind: "task.started", correlation_id: "task", payload: {} });
  input.emit("data", Buffer.from("\x03"));
  assert.equal(cancelled, true, "input must observe earlier lifecycle events");
});

test("input errors exit through terminal restoration and detach listeners", async () => {
  const driver = new MemoryTerminalDriver({ columns: 60, rows: 12 });
  const ui = new TerminalUI({ driver });
  const input = new EventEmitter();
  const loop = ui.interactiveLoop!;
  loop.start(() => {});
  const done = loop.run(input);
  const error = new Error("stdin disconnected");
  input.emit("error", error);
  assert.equal(driver.restored, false, "raw mode must survive until late reports are drained");
  await done;
  assert.equal(ui.renderError, error);
  assert.equal(driver.restoreCalls, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
  assert.ok(driver.writes().includes("\x1b[<u"));
});

test("terminal write failures still restore modes exactly once", async () => {
  class BrokenDriver extends MemoryTerminalDriver {
    override write(): void { throw new Error("stdout disconnected"); }
  }
  const driver = new BrokenDriver({ columns: 40, rows: 12 });
  const ui = new TerminalUI({ driver });
  await ui.interactiveLoop!.run();
  assert.match(String(ui.renderError), /stdout disconnected/);
  assert.equal(driver.restoreCalls, 1);
});

test("Termux height-only changes retain scrollback while width changes repaint", () => {
  const driver = new MemoryTerminalDriver({ columns: 20, rows: 12 });
  const renderer = new MainScreenRenderer(driver, { TERMUX_VERSION: "fixture" });
  const frame = { lines: Array.from({ length: 30 }, (_, index) => String(index)), activeStart: 30, cursorRow: 29, cursorCol: 0 };
  renderer.render(frame);
  driver.clearWrites();
  driver.resize({ columns: 20, rows: 8 });
  renderer.render(frame);
  assert.equal(driver.writes().includes("\x1b[3J"), false);
  driver.clearWrites();
  driver.resize({ columns: 15, rows: 8 });
  renderer.render(frame);
  assert.equal(driver.writes().includes("\x1b[3J"), true);
});

test("terminal screen diffs clear removed rows and recover after width changes", async (t) => {
  const terminal = new xterm.Terminal({ cols: 20, rows: 8, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const driver = new MemoryTerminalDriver({ columns: 20, rows: 8 });
  const renderer = new MainScreenRenderer(driver);
  const paint = async (lines: string[], cursorRow = lines.length - 1) => {
    driver.clearWrites();
    renderer.render({ lines, activeStart: 0, cursorRow, cursorCol: 0 });
    await new Promise<void>(resolve => terminal.write(driver.writes(), resolve));
  };
  await paint(["\x1b[31m中文", "old second", "old third"]);
  await paint(["新", "short"]);
  assert.equal(terminal.buffer.active.getLine(0)!.translateToString(true), "新");
  assert.equal(terminal.buffer.active.getLine(2)!.translateToString(true), "");
  terminal.resize(10, 8);
  driver.resize({ columns: 10, rows: 8 });
  await paint(["恢复", "ready"]);
  assert.equal(terminal.buffer.active.getLine(0)!.translateToString(true), "恢复");
  assert.equal(terminal.buffer.active.cursorY, 1);
  assert.equal(terminal.buffer.active.cursorX, 0);
});

test("setup prompt uses the same cell-aware renderer for edits and resize", async (t) => {
  const terminal = new xterm.Terminal({ cols: 8, rows: 10, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const input = new PassThrough();
  let pending = "";
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { pending += chunk.toString(); done(); } }), { columns: 8, rows: 10 });
  const session = new TerminalInputSession({ input, output });
  const done = session.prompt();
  const paint = async () => {
    const text = pending;
    pending = "";
    await new Promise<void>(resolve => terminal.write(text, resolve));
  };
  input.write("中文a");
  await paint();
  assert.equal(terminal.buffer.active.cursorY, 1);
  assert.equal(terminal.buffer.active.cursorX, 7);
  input.write("\x7f");
  await paint();
  assert.equal(terminal.buffer.active.getLine(1)!.translateToString(true), "❯ 中文");
  terminal.resize(6, 10);
  output.columns = 6;
  output.emit("resize");
  await paint();
  assert.equal(terminal.buffer.active.cursorY, 2);
  assert.equal(terminal.buffer.active.cursorX, 2);
  input.write("\r");
  assert.equal(await done, "中文");
  await paint();
  assert.equal(terminal.buffer.active.getLine(1)!.translateToString(true), "");
  assert.equal(output.listenerCount("resize"), 0);
});

test("streaming fences and styled table graphemes remain stable at narrow widths", () => {
  for (const end of ["`", "``", "```"]) {
    assert.equal(printable(render("```ts\nhello\n" + end, 20)), "hello");
  }
  const table = "| label | text |\n| --- | --- |\n| ⚠**️** | hello |";
  for (let width = 1; width <= 40; width++) {
    assert.ok(render(table, width).every(value => visibleWidth(value) <= width));
  }
});
