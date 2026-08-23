import test from "node:test";
import assert from "node:assert/strict";

import { BasicEditorState } from "../src/terminal/ui.ts";
import { FrameBuilder } from "../src/ui/frame-builder.ts";
import { TranscriptStore } from "../src/ui/transcript-store.ts";
import { createUIState } from "../src/ui-state.ts";

test("frame builder exposes title, welcome, and status data", () => {
  const state = createUIState();
  state.pendingCount = 2;
  state.heldCount = 1;
  state.provider = "openai";
  state.model = "gpt-test";
  const store = new TranscriptStore();
  store.append({ kind: "notice", key: "welcome", text: "laoHuangCode  /help for commands" });
  const editor = new BasicEditorState();
  editor.text = "hello";
  editor.cursor = 5;

  const frame = new FrameBuilder({
    state,
    transcript: store,
    projectRoot: "/Users/example/projects/a-very-long-project-name-that-must-be-truncated-in-the-status-bar",
    title: "laoHuangCode",
  }).build({ width: 120, editor });

  assert.equal(frame.titleBar, "laoHuangCode");
  assert.deepEqual(frame.welcomeBlock, ["laoHuangCode  /help for commands"]);
  assert.match(frame.statusBar, /queue 2 pending \/ 1 held/);
  assert.match(frame.statusBar, /openai\/gpt-test/);
  assert.ok(frame.statusBar.includes("…"));
  assert.deepEqual(frame.cursor, { row: frame.screen.cursorRow, col: 7 });
});
