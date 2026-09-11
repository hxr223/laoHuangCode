import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextUsage } from "@laohuang/session-context";
import type { ModelUsage } from "@laohuang/llm";
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
  assert.equal(baseTokens, 0);
  const originalId = controller.currentSessionId!;
  const user = controller.history!.appendUser({
    message: { role: "user", content: "x".repeat(12_000) }, inputEventIds: [], source: "direct",
  });
  refresh();
  const fullTokens = ui.state.contextTokens;
  assert.equal(fullTokens, 3000);

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

test("context usage excludes initialization and waits for post-compaction measured usage", async (t) => {
  const { controller, ui, refresh } = await fixture(t);
  const history = controller.history!;
  refresh();
  const instructions = { role: "user", content: "Project rules: use TypeScript." } as const;
  history.appendProjectInstructions({ message: instructions, files: [] });
  refresh();
  assert.equal(ui.state.contextTokens, 0);
  const user = history.appendUser({
    message: { role: "user", content: "x".repeat(12_000) }, inputEventIds: [], source: "direct",
  });
  refresh();
  const beforeReply = ui.state.contextTokens;
  assert.equal(beforeReply, 3000);
  const reply = { role: "assistant", provider: "test", model: "model-a",
    content: [{ type: "text", text: "done" }] } as const;
  const assistant = history.appendAssistant({ message: reply, requestId: "request", finishReason: "stop" });
  refresh();
  assert.equal(ui.state.contextTokens, 3001);
  history.appendCompaction({
    summary: "Previous work is complete.",
    summarizedFromSeq: user.seq,
    summarizedThroughSeq: user.seq,
    retainedFromSeq: assistant.seq,
    tokensBefore: 3001,
    retainedTokens: 9,
    summaryInputTokens: 3000,
    summaryOutputTokens: 6,
    provider: "test", model: "model-a", trigger: "manual",
  });
  const beforeRefresh = history.entries();
  refresh(128_000, "model-b");
  assert.equal(ui.state.contextTokens, null);
  assert.equal(ui.state.contextWindow, 128_000);
  assert.deepEqual(history.entries(), beforeRefresh, "refresh must not write or compact history");
  history.appendAssistant({ message: reply, requestId: "no-usage", finishReason: "stop" });
  refresh();
  assert.equal(ui.state.contextTokens, null);
  history.appendAssistant({ message: reply, requestId: "measured", finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 5 } });
  refresh();
  assert.equal(ui.state.contextTokens, 105);
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
  assert.match(stripTerminalControls(driver.writes()), /context: 0%/);
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
  ui.setContextUsage(null, 1_000_000);
  assert.ok(ui.buildFrame({ width: 100, editor: new EditorState() }).lines
    .some((line) => stripTerminalControls(line).includes("context: ? (?/1M)")));
});

test("measured usage replaces estimates and survives resume, clone and fork", async (t) => {
  const { controller, refresh, ui } = await fixture(t);
  const history = controller.history!;
  const sessionId = controller.currentSessionId!;
  const user = history.appendUser({ message: { role: "user", content: "hello" }, inputEventIds: [], source: "direct" });
  const reply = { role: "assistant", provider: "test", model: "model-a",
    content: [{ type: "text", text: "answer" }] } as const;
  history.appendAssistant({ message: reply, requestId: "measured", finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, reasoningTokens: 10 } });
  assert.equal(history.contextTokens, 190);
  const nextUser = history.appendUser({ message: { role: "user", content: "12345678" }, inputEventIds: [], source: "direct" });
  assert.equal(history.contextTokens, 192);
  history.appendAssistant({ message: reply, requestId: "next", finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 10, cacheReadTokens: 200 } });
  assert.equal(history.contextTokens, 210);
  for (const usage of [undefined, { inputTokens: 0, outputTokens: 0 },
    { inputTokens: -1, outputTokens: 100 }, { inputTokens: NaN, outputTokens: 100 },
    { inputTokens: Infinity, outputTokens: 1 }] satisfies Array<ModelUsage | undefined>) {
    const before = history.contextTokens!;
    history.appendAssistant({ message: reply, requestId: "invalid", finishReason: "stop", ...(usage ? { usage } : {}) });
    assert.equal(history.contextTokens, before + 2);
  }
  const expected = history.contextTokens;
  await controller.createNew();
  assert.equal(controller.history!.contextTokens, 0);
  await controller.resume(sessionId);
  assert.equal(controller.history!.contextTokens, expected);
  await controller.clone();
  assert.equal(controller.history!.contextTokens, expected);
  await controller.resume(sessionId);
  await controller.fork(nextUser.id, "before");
  assert.equal(controller.history!.contextTokens, 190);
  refresh();
  assert.equal(ui.state.contextTokens, 190);
  await controller.resume(sessionId);
  await controller.fork(user.id, "before");
  assert.equal(controller.history!.contextTokens, 0);
});

test("session switch discards queued usage and drafts do not change it", async (t) => {
  const { ui } = await fixture(t);
  ui.setSessionId("old");
  ui.setContextUsage(9000, 1_000_000);
  ui.setSessionId("new");
  ui.feedInputBytes(Buffer.from("draft"));
  ui.drainLoop();
  assert.equal(ui.state.contextTokens, 0);
  ui.publishEvent({ kind: "ui.context_usage", session_id: "old", payload: { context_tokens: 9000 } });
  ui.setContextUsage(null, 128_000);
  ui.drainLoop();
  assert.equal(ui.state.contextTokens, null);
});

test("live counting accepts incomplete tool batches and only estimates appended content", async (t) => {
  const { controller } = await fixture(t);
  const history = controller.history!;
  history.appendAssistant({ requestId: "tool", finishReason: "tool-calls", usage: { inputTokens: 100, outputTokens: 20 },
    message: { role: "assistant", provider: "test", model: "model-a", content: [
      { type: "tool-call", call: { id: "call", name: "read", arguments: {} } },
    ] } });
  const tracker = new ContextUsage(history.entries());
  assert.equal(tracker.tokens, 120);
  let reads = 0;
  const result = history.appendToolResults({ requestId: "tool", recovered: false, messages: [
    { role: "tool-result", toolCallId: "call", toolName: "read", content: "12345678", isError: false },
  ] })[0]!;
  const instrumented = { ...result, payload: { ...result.payload, message: { ...result.payload.message,
    get content() { reads++; return "12345678"; },
  } } };
  tracker.append(instrumented);
  for (let i = 0; i < 1000; i++) assert.equal(tracker.tokens, 122);
  assert.equal(reads, 1);
  assert.equal(history.contextTokens, 122);
});
