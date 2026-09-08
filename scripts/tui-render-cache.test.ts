import assert from "node:assert/strict";
import test from "node:test";

import { StyledLineCompiler } from "../packages/terminal/tui/src/tui/ansi-renderer.ts";
import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";
import { FrameBuilder } from "../packages/terminal/tui/src/tui/frame-builder.ts";
import { line, span } from "../packages/terminal/tui/src/tui/render-model.ts";
import { MainScreenRenderer, MemoryTerminalDriver, stripTerminalControls, visibleWidth } from "../packages/terminal/tui/src/tui/screen.ts";
import { createUIState } from "../packages/terminal/tui/src/tui/state.ts";
import { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME } from "../packages/terminal/tui/src/tui/theme.ts";
import { createAssistantBlock, TranscriptStore } from "../packages/terminal/tui/src/tui/transcript-store.ts";
import { TerminalUI } from "../packages/terminal/tui/src/tui/ui.ts";

test("typing with long history reuses compiled history through the entire render loop", (t) => {
  const driver = new MemoryTerminalDriver({ columns: 100, rows: 24 });
  const editor = new EditorState();
  const ui = new TerminalUI({ driver, editorFactory: () => editor, theme: "dark" });
  t.after(() => ui.close());
  // Distinct lines exceed the small width cache so it cannot hide a full scan.
  for (let index = 0; index < 1_000; index += 1) {
    ui.appendTranscript(createAssistantBlock(String(index), `\`历史缓存消息 ${index}\` 中文内容 abcdefghijklmnopqrstuvwxyz`, false));
  }
  ui.startLoop(() => {});
  ui.drainLoop();
  assert.equal(ui.renderError, null);
  driver.clearWrites();

  let historySegments = 0;
  const segment = Intl.Segmenter.prototype.segment;
  t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string) {
    if (input.includes("历史缓存消息")) historySegments += 1;
    return segment.call(this, input);
  });
  const sgr = t.mock.method(ui.theme, "sgr");
  for (const key of ["a", "b", "c"]) {
    ui.feedInputBytes(new TextEncoder().encode(key));
    ui.drainLoop();
  }

  assert.equal(ui.renderError, null);
  assert.equal(editor.text, "abc");
  assert.match(stripTerminalControls(driver.writes()), /> abc/);
  assert.equal(driver.writes().includes("历史缓存消息"), false);
  assert.equal(historySegments, 0, "unchanged history must not be segmented again");
  assert.ok(sgr.mock.callCount() < 100, "typing must not recompile the colors of old messages");
});

test("fallback frame building also reuses compiled history", (t) => {
  const transcript = new TranscriptStore();
  for (let index = 0; index < 600; index += 1) {
    transcript.append(createAssistantBlock(String(index), `\`备用历史 ${index}\``, false));
  }
  const builder = new FrameBuilder({ state: createUIState(), transcript, theme: DEFAULT_DARK_THEME });
  const editor = new EditorState();
  const first = builder.build({ width: 80, editor });
  const sgr = t.mock.method(DEFAULT_DARK_THEME, "sgr");
  editor.text = "abc";
  editor.cursor = 3;
  const next = builder.build({ width: 80, editor });

  assert.equal(next.screen.lines[0], first.screen.lines[0]);
  assert.ok(sgr.mock.callCount() < 100, "fallback must reuse old message colors");
});

test("width measurement reuses Unicode results and skips segmentation for printable ASCII", (t) => {
  const segment = t.mock.method(Intl.Segmenter.prototype, "segment");
  assert.equal(visibleWidth("printable ASCII 123"), 19);
  assert.equal(segment.mock.callCount(), 0);
  const value = "\x1b[32m缓存宽度 e\u0301 👨‍👩‍👧‍👦\x1b[0m";
  assert.equal(visibleWidth(value), 13);
  const calls = segment.mock.callCount();
  assert.equal(visibleWidth(value), 13);
  assert.equal(segment.mock.callCount(), calls);
});

test("screen rejects invalid changed lines before writing and revalidates after narrowing", () => {
  const driver = new MemoryTerminalDriver({ columns: 8, rows: 4 });
  const renderer = new MainScreenRenderer(driver);
  const frame = { lines: ["历史", "12345678"], activeStart: 2, cursorRow: 1, cursorCol: 0 };
  renderer.render(frame);
  driver.clearWrites();
  for (const invalid of ["123456789", "bad\nline"]) {
    assert.throws(() => renderer.render({ ...frame, lines: ["历史", invalid] }), /exceeds terminal width|physical newline/);
    assert.equal(driver.writes(), "");
  }
  driver.resize({ columns: 4, rows: 4 });
  assert.throws(() => renderer.render(frame), /exceeds terminal width/);
  assert.equal(driver.writes(), "");
});

test("compiled lines refresh for width, theme, and replacement styled content", () => {
  const compiler = new StyledLineCompiler();
  const value = line(span("你好abcd", { foreground: "error" }));
  assert.deepEqual(compiler.compile([value], 8, DEFAULT_DARK_THEME), ["\x1b[38;2;204;102;102m你好abcd\x1b[0m"]);
  assert.deepEqual(compiler.compile([value], 4, DEFAULT_DARK_THEME), ["\x1b[38;2;204;102;102m你好\x1b[0m"]);
  assert.deepEqual(compiler.compile([value], 8, DEFAULT_LIGHT_THEME), ["\x1b[38;2;170;85;85m你好abcd\x1b[0m"]);
  assert.deepEqual(compiler.compile([line(span("updated"))], 8, DEFAULT_DARK_THEME), ["updated"]);
});

test("cached fallback transcript refreshes when another session reuses block IDs", () => {
  const transcript = new TranscriptStore();
  const builder = new FrameBuilder({ state: createUIState(), transcript });
  const editor = new EditorState();
  transcript.replace([{ kind: "assistant", text: "old session" }]);
  assert.equal(stripTerminalControls(builder.build({ width: 80, editor }).screen.lines[0]!), "old session");
  transcript.replace([{ kind: "assistant", text: "new session" }]);
  assert.equal(stripTerminalControls(builder.build({ width: 80, editor }).screen.lines[0]!), "new session");
  transcript.replace([]);
  assert.equal(builder.build({ width: 80, editor }).screen.lines.some((value) => value.includes("session")), false);
});

test("frame clipping cache responds to changed lines and terminal width", () => {
  const builder = new FrameBuilder({ state: createUIState(), transcript: new TranscriptStore() });
  const editor = new EditorState();
  const compiledMainScreen = { lines: ["你好abcd"], activeStart: 0, cursor: { row: 0, column: 0 } };
  assert.deepEqual(builder.build({ width: 9, editor, compiledMainScreen }).screen.lines, ["你好abcd"]);
  assert.deepEqual(builder.build({ width: 5, editor, compiledMainScreen }).screen.lines, ["你好"]);
  assert.deepEqual(builder.build({ width: 9, editor, compiledMainScreen }).screen.lines, ["你好abcd"]);
  compiledMainScreen.lines[0] = "changed";
  assert.deepEqual(builder.build({ width: 9, editor, compiledMainScreen }).screen.lines, ["changed"]);
});

test("stream updates, tool expansion, resize, and session replacement refresh cached frames", (t) => {
  const driver = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver, theme: "dark" });
  t.after(() => ui.close());
  ui.appendTranscript(createAssistantBlock("history", "old history", false));
  ui.startLoop(() => {});
  ui.drainLoop();
  const publish = (kind: string, correlation_id: string, payload: Record<string, unknown>): void => {
    driver.clearWrites();
    ui.publishEvent({ kind, correlation_id, payload });
    ui.drainLoop();
    assert.equal(ui.renderError, null);
  };
  publish("model.text_delta", "response", { text: "stream" });
  publish("model.text_delta", "response", { text: "ing reply" });
  assert.match(stripTerminalControls(driver.writes()), /streaming reply/);
  assert.equal(driver.writes().includes("old history"), false);
  publish("model.response_committed", "response", {});
  publish("tool.started", "call", { name: "bash", arguments: { command: "echo result" } });
  publish("tool.finished", "call", { status: "completed", stdout: "tool result", exit_code: 0 });
  ui.applyDisplayAction({ type: "toggle_tool_output", expanded: true });
  ui.drainLoop();
  assert.match(stripTerminalControls(driver.writes()), /tool result/);

  driver.clearWrites();
  driver.resize({ columns: 12, rows: 24 });
  ui.drainLoop();
  assert.equal(ui.renderError, null);
  const narrow = ui.buildFrame({ width: 12, editor: new EditorState() });
  assert.ok(narrow.lines.every((value) => visibleWidth(value) <= 11));
  driver.resize({ columns: 80, rows: 24 });
  ui.drainLoop();
  assert.ok(ui.buildHistoryLines(79).some((value) => stripTerminalControls(value) === "streaming reply"));

  ui.replaceTranscript([{ kind: "assistant", text: "replacement session" }]);
  ui.drainLoop();
  assert.deepEqual(ui.buildHistoryLines(79).map(stripTerminalControls), ["replacement session"]);
  ui.replaceTranscript([]);
  ui.drainLoop();
  assert.deepEqual(ui.buildHistoryLines(79), []);
  assert.equal(ui.renderError, null);
});
