import test from "node:test";
import assert from "node:assert/strict";

import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";
import { FrameBuilder } from "../packages/terminal/tui/src/tui/frame-builder.ts";
import { TranscriptStore } from "../packages/terminal/tui/src/tui/transcript-store.ts";
import { createUIState } from "../packages/terminal/tui/src/tui/state.ts";

test("frame builder exposes title, welcome, and status data", () => {
  const state = createUIState();
  state.pendingCount = 2;
  state.heldCount = 1;
  state.provider = "openai";
  state.model = "gpt-test";
  const store = new TranscriptStore();
  store.append({ kind: "notice", key: "welcome", text: "hello, welcome to laoHuang" });
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
  assert.deepEqual(frame.welcomeBlock, ["hello, welcome to laoHuang"]);
  assert.match(frame.screen.lines[0] as string, /^╭─ laoHuang ─+╮$/u);
  assert.ok(frame.screen.lines.includes("│ hello, welcome to laoHuang".padEnd(119, " ") + "│"));
  assert.ok(frame.screen.lines.some((line) => line.startsWith("│ ❯ hello")));
  assert.ok(frame.screen.lines.some((line) => line.startsWith("├") && line.endsWith("┤")));
  assert.match(frame.screen.lines.at(-1) as string, /^╰─+╯$/u);
  assert.match(frame.statusBar, /queue 2 pending \/ 1 held/);
  assert.match(frame.statusBar, /openai\/gpt-test/);
  assert.ok(frame.statusBar.includes("…"));
  assert.deepEqual(frame.cursor, { row: frame.screen.cursorRow, col: 9 });
});
