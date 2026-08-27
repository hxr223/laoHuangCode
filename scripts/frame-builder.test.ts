import test from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";
import { FrameBuilder } from "../packages/terminal/tui/src/tui/frame-builder.ts";
import {
  createAssistantBlock,
  createWelcomeBlock,
  TranscriptStore,
} from "../packages/terminal/tui/src/tui/transcript-store.ts";
import { createUIState } from "../packages/terminal/tui/src/tui/state.ts";
import { visibleWidth } from "../packages/terminal/tui/src/tui/screen.ts";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/gu, "");
}

test("main screen keeps transcript unframed while composer owns the input frame", () => {
  const state = createUIState();
  const transcript = new TranscriptStore();
  transcript.append(createAssistantBlock("answer-1", "answer", false));
  const editor = new EditorState();
  editor.text = "abc";
  editor.cursor = 3;

  const frame = new FrameBuilder({ state, transcript }).build({ width: 40, editor });

  assert.equal(stripAnsi(frame.screen.lines[0]!), "answer");
  assert.equal(frame.screen.lines.some((value) => stripAnsi(value).includes("│answer")), false);
  assert.ok(frame.screen.lines.some((value) => stripAnsi(value).startsWith("╭")));
  assert.ok(frame.screen.lines.some((value) => stripAnsi(value).includes("> abc")));
});

test("kimi-style screen exposes welcome, responsive status, and cursor data", () => {
  const state = createUIState();
  state.pendingCount = 2;
  state.heldCount = 1;
  state.provider = "openai";
  state.model = "gpt-test";
  const store = new TranscriptStore();
  store.append(createWelcomeBlock("Welcome to LaoHuang Code!", [
    "Send /help for help information.",
    "Directory: /Users/example/projects/a-very-long-project-name-that-must-be-truncated-in-the-status-bar",
    "Session: session_123",
    "Model: openai/gpt-test",
    "Version: 0.0.0",
  ]));
  store.append({ kind: "notice", key: "other", text: "laoHuangCode diagnostic detail" });
  const editor = new EditorState();
  editor.text = "hello";
  editor.cursor = 5;

  const frame = new FrameBuilder({
    state,
    transcript: store,
    projectRoot: "/Users/example/projects/a-very-long-project-name-that-must-be-truncated-in-the-status-bar",
    title: "laoHuang",
  }).build({ width: 120, editor });

  assert.equal(frame.titleBar, "laoHuang");
  assert.deepEqual(frame.welcomeBlock, [
    "Welcome to LaoHuang Code!",
    "Send /help for help information.",
    "Directory: /Users/example/projects/a-very-long-project-name-that-must-be-truncated-in-the-status-bar",
    "Session: session_123",
    "Model: openai/gpt-test",
    "Version: 0.0.0",
  ]);
  assert.ok(frame.screen.lines.some((line) => stripAnsi(line).includes("Welcome to LaoHuang Code!")));
  assert.ok(frame.screen.lines.some((line) => stripAnsi(line).includes("│> hello")));
  assert.equal(stripAnsi(frame.screen.lines[0]!).startsWith("╭"), true);
  assert.equal(frame.screen.lines.some((line) => stripAnsi(line).includes("│laoHuangCode diagnostic")), false);
  assert.equal(frame.screen.lines.some((line) => stripAnsi(line).includes("laoHuangCode diagnostic")), true);
  assert.match(frame.statusBar, /queue 2 pending \/ 1 held/);
  assert.match(frame.statusBar, /openai\/gpt-test/);
  assert.deepEqual(frame.cursor, { row: frame.screen.cursorRow, col: 8 });
});

test("status drops cwd then tokens before truncating provider and model", () => {
  const state = createUIState();
  state.pendingCount = 2;
  state.inputTokens = 120;
  state.outputTokens = 45;
  state.totalTokens = 165;
  state.provider = "long-provider";
  state.model = "long-model-name";

  const frame = new FrameBuilder({
    state,
    transcript: new TranscriptStore(),
    projectRoot: "/a/very/long/project/root",
    effort: "high",
  }).build({ width: 30, editor: new EditorState() });

  assert.ok(frame.statusBar.includes("queue 2 pending / 0 held"));
  assert.ok(!frame.statusBar.includes("/a/very/long"));
  assert.ok(!frame.statusBar.includes("↑120"));
  assert.ok(frame.screen.lines.every((line) => visibleWidth(line) <= 29));

  const wide = new FrameBuilder({
    state,
    transcript: new TranscriptStore(),
    effort: "high",
  }).build({ width: 100, editor: new EditorState() });
  assert.ok(wide.statusBar.includes("effort high"));
});
