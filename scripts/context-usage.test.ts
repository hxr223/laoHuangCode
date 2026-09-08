import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultTokenEstimator } from "@laohuang/session-context";
import type { ToolSpec } from "@laohuang/tools";
import { refreshSessionContextUsage } from "../apps/cli/src/main.ts";
import { SessionController } from "../apps/cli/src/session-controller.ts";
import { TerminalUI } from "../packages/terminal/tui/src/tui/ui.ts";
import { MemoryTerminalDriver, stripTerminalControls } from "../packages/terminal/tui/src/tui/screen.ts";
import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";

const tools: readonly ToolSpec[] = [{
  name: "read",
  description: "Read a local file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  promptGuidelines: [],
}];
const system = { role: "system", content: "You are a coding assistant." } as const;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laohuang-context-usage-"));
  const controller = new SessionController({
    sessionsRoot: join(root, "sessions"),
    projectRoot: root,
    initialCwd: root,
    appVersion: "0.0.0",
    provider: "test",
    model: "model-a",
    reasoningEffort: "off",
  });
  const driver = new MemoryTerminalDriver({ columns: 100, rows: 24 });
  const ui = new TerminalUI({ driver });
  t.after(async () => {
    ui.close();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  await controller.createNew();
  controller.history!.appendSystemContext({ message: system, cwd: root });
  const refresh = (contextWindow = 1_000_000, currentModel = "model-a") => {
    refreshSessionContextUsage(ui, {
      entries: controller.history!.entries(),
      currentProvider: "test",
      currentModel,
      tools,
      contextWindow,
    });
    ui.drainLoop();
  };
  return { controller, ui, driver, root, refresh };
}

test("context usage follows new, resumed, cloned and forked session histories", async (t) => {
  const { controller, ui, root, refresh } = await fixture(t);
  refresh();
  const baseTokens = ui.state.contextTokens;
  const estimator = new DefaultTokenEstimator();
  assert.equal(baseTokens, estimator.estimateMessages([system]) + estimator.estimateTools(tools));
  const originalId = controller.currentSessionId!;
  const user = controller.history!.appendUser({
    message: { role: "user", content: "x".repeat(12_000) }, inputEventIds: [], source: "direct",
  });
  refresh();
  const fullTokens = ui.state.contextTokens;
  assert.equal(fullTokens, baseTokens + 3008);

  await controller.createNew();
  controller.history!.appendSystemContext({ message: system, cwd: root });
  ui.setSessionId(controller.currentSessionId!);
  refresh();
  assert.equal(ui.state.contextTokens, baseTokens);

  await controller.resume(originalId);
  refresh();
  assert.equal(ui.state.contextTokens, fullTokens);
  await controller.clone();
  refresh();
  assert.equal(ui.state.contextTokens, fullTokens);
  await controller.resume(originalId);
  await controller.fork(user.id, "before");
  refresh();
  assert.equal(ui.state.contextTokens, baseTokens);
});

test("context usage includes instructions and committed replies, and uses the active compacted tail", async (t) => {
  const { controller, ui, refresh } = await fixture(t);
  const history = controller.history!;
  refresh();
  const baseTokens = ui.state.contextTokens;
  const instructions = { role: "user", content: "Project rules: use TypeScript." } as const;
  history.appendProjectInstructions({ message: instructions, files: [] });
  const user = history.appendUser({
    message: { role: "user", content: "x".repeat(12_000) }, inputEventIds: [], source: "direct",
  });
  refresh();
  const beforeReply = ui.state.contextTokens;
  const reply = { role: "assistant", provider: "test", model: "model-a",
    content: [{ type: "text", text: "done" }] } as const;
  const assistant = history.appendAssistant({ message: reply, requestId: "request", finishReason: "stop" });
  refresh();
  assert.equal(ui.state.contextTokens, beforeReply + 9);
  history.appendCompaction({
    summary: "Previous work is complete.",
    summarizedFromSeq: user.seq,
    summarizedThroughSeq: user.seq,
    retainedFromSeq: assistant.seq,
    tokensBefore: ui.state.contextTokens,
    retainedTokens: 9,
    summaryInputTokens: 3000,
    summaryOutputTokens: 6,
    provider: "test", model: "model-a", trigger: "manual",
  });
  const beforeRefresh = history.entries();
  refresh(128_000, "model-b");
  const estimator = new DefaultTokenEstimator();
  assert.equal(ui.state.contextTokens, baseTokens + estimator.estimateMessages([
    instructions,
    { role: "user", content: "<conversation_summary>\nPrevious work is complete.\n</conversation_summary>" },
    reply,
  ]));
  assert.equal(ui.state.contextWindow, 128_000);
  assert.ok(ui.state.contextTokens < beforeReply);
  assert.deepEqual(history.entries(), beforeRefresh, "refresh must not write or compact history");
});

test("queued context refresh wins over old request usage and redraws without transcript noise", async (t) => {
  const { ui, driver, refresh } = await fixture(t);
  refresh();
  const baseTokens = ui.state.contextTokens;
  ui.startLoop(() => {});
  ui.drainLoop();
  driver.clearWrites();
  ui.publishEvent({ kind: "model.request_started", correlation_id: "old-request",
    payload: { context_tokens: 3000, context_window: 1_000_000 } });
  ui.publishEvent({ kind: "task.completed", payload: {} });
  refresh(128_000);
  ui.drainLoop();
  assert.equal(ui.state.contextTokens, baseTokens);
  assert.equal(ui.state.contextWindow, 128_000);
  assert.match(stripTerminalControls(driver.writes()), /context: <0\.1%/);
  const transcript = ui.buildHistoryLines(100);
  ui.setContextUsage(512, 8192);
  ui.drainLoop();
  assert.deepEqual(ui.buildHistoryLines(100), transcript);
  assert.match(stripTerminalControls(driver.writes()), /context: 6\.3%/);
});

test("context percentages distinguish zero, tiny values and fractional percentages", () => {
  const ui = new TerminalUI();
  for (const [tokens, expected] of [
    [0, "0%"], [1, "<0.1%"], [999, "<0.1%"], [1000, "0.1%"],
    [3000, "0.3%"], [1_000_000, "100%"],
  ] as const) {
    ui.setContextUsage(tokens, 1_000_000);
    const frame = ui.buildFrame({ width: 100, editor: new EditorState() });
    assert.ok(frame.lines.some((line) => stripTerminalControls(line).includes(`context: ${expected} (`)));
  }
});
