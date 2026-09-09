import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionController } from "../apps/cli/src/session-controller.ts";
import { copyText } from "../apps/cli/src/clipboard.ts";
import { TerminalCommandPresenter } from "../apps/cli/src/terminal-command-presenter.ts";
import { TerminalUI } from "@laohuang/tui";
import { MemoryTerminalDriver, stripTerminalControls } from "../packages/terminal/tui/src/tui/screen.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";
import { createSessionCommandFixture } from "./helpers/session-command-fixture.ts";
import type { AssistantContentBlock, ModelFinishReason } from "@laohuang/llm";

async function controllerFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "laohuang-name-copy-"));
  const controller = new SessionController({
    sessionsRoot: root, projectRoot: root, initialCwd: root, appVersion: "0.8.3",
    provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high",
  });
  t.after(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
  await controller.createNew();
  return controller;
}

function assistant(controller: SessionController, content: readonly AssistantContentBlock[], finishReason: ModelFinishReason = "stop") {
  controller.history!.appendAssistant({
    message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-flash", content },
    requestId: "fixture", finishReason,
  });
}

test("copy reads text blocks only and survives compaction and resume", async (t) => {
  const controller = await controllerFixture(t);
  assert.equal(controller.latestAssistantText(), null);
  assistant(controller, [{ type: "reasoning", text: "private thinking" }]);
  assert.equal(controller.latestAssistantText(), null);
  assistant(controller, [
    { type: "text", text: "## answer\n" }, { type: "reasoning", text: "private thinking" },
    { type: "text", text: "```ts\nconst a = 1;\n```\n" },
  ], "max-tokens");
  const expected = "## answer\n```ts\nconst a = 1;\n```\n";
  assistant(controller, [{ type: "tool-call", call: { id: "tool-fixture", name: "read", arguments: {} } }], "tool-calls");
  controller.history!.appendToolResults({
    requestId: "fixture", recovered: false,
    messages: [{ role: "tool-result", toolCallId: "tool-fixture", toolName: "read", content: "not the answer", isError: false }],
  });
  controller.history!.appendCompaction({
    summary: "summary is not the answer", summarizedFromSeq: 1, summarizedThroughSeq: 3,
    retainedFromSeq: 4, tokensBefore: 100, retainedTokens: 20, summaryInputTokens: 5, summaryOutputTokens: 5,
    provider: "deepseek", model: "deepseek-v4-flash", trigger: "manual",
  });
  assert.equal(controller.latestAssistantText(), expected);
  const id = controller.currentSessionId!;
  await controller.close();
  await controller.resume(id);
  assert.equal(controller.latestAssistantText(), expected);
});

test("slash name persists without resetting the session and appears in session display", async (t) => {
  const controller = await controllerFixture(t);
  const presenter = new RecordingPresenter();
  let resets = 0;
  const { commands, agent } = createSessionCommandFixture({
    presenter, sessionController: controller, onSessionChanged: () => { resets += 1; },
    copyText: async () => ({ status: "copied" }),
  });
  const history = [...agent.messages];
  assert.equal((await commands.registry.execute('/name "MCP 接入设计"', { state: "RUNNING_MODEL" })).status, "handled");
  assert.equal(controller.currentTitle, "MCP 接入设计");
  assert.equal((await commands.execute("/name")).status, "handled");
  assert.equal((await commands.execute("/session")).status, "handled");
  assert.equal((await commands.execute("/sessions")).status, "handled");
  assert.equal((await commands.execute("/resume")).status, "handled");
  assert.equal(presenter.selections.at(-1)?.items[0]?.label, "MCP 接入设计");
  assert.match(presenter.notices.map((notice) => notice.text).join("\n"), /MCP 接入设计/);
  assert.equal((await commands.execute('/name ""')).status, "error");
  for (const invalid of ["/name bad\nname", "/name bad\tname", '/name "bad\u0085name"']) {
    assert.equal((await commands.registry.execute(invalid, { state: "IDLE" })).status, "error");
  }
  assert.equal(controller.currentTitle, "MCP 接入设计");
  assert.equal(resets, 0);
  assert.deepEqual(agent.messages, history);
});

test("copy has no clipboard side effect without text, and uses recorded text while running", async (t) => {
  const controller = await controllerFixture(t);
  const presenter = new RecordingPresenter();
  const copied: string[] = [];
  const { commands, agent } = createSessionCommandFixture({
    presenter, sessionController: controller,
    copyText: async (text) => { copied.push(text); return { status: "copied" }; },
  });
  assert.equal((await commands.execute("/copy")).status, "handled");
  assert.deepEqual(copied, []);
  assistant(controller, [{ type: "text", text: "completed answer" }]);
  agent.messages.push({ role: "assistant", content: "unfinished or compacted model context" });
  assert.equal((await commands.registry.execute("/copy", { state: "RUNNING_MODEL" })).status, "handled");
  assert.deepEqual(copied, ["completed answer"]);
  assert.equal((await commands.execute("/copy extra")).status, "error");
  assert.deepEqual(copied, ["completed answer"]);
});

test("copy takes one history snapshot even if a new answer arrives before completion", async (t) => {
  const controller = await controllerFixture(t);
  assistant(controller, [{ type: "text", text: "first" }]);
  const copied: string[] = [];
  const { commands } = createSessionCommandFixture({
    presenter: new RecordingPresenter(), sessionController: controller,
    copyText: async (text) => {
      assistant(controller, [{ type: "text", text: "second" }]);
      await Promise.resolve();
      copied.push(text);
      return { status: "copied" };
    },
  });
  assert.equal((await commands.execute("/copy")).status, "handled");
  assert.deepEqual(copied, ["first"]);
});

test("failed and terminal-only copies never produce a confirmed-success notice", async (t) => {
  const controller = await controllerFixture(t);
  assistant(controller, [{ type: "text", text: "answer" }]);
  for (const result of [{ status: "unavailable", reason: "fixture backend failure" }, { status: "sent-to-terminal" }] as const) {
    const presenter = new RecordingPresenter();
    const { commands } = createSessionCommandFixture({ presenter, sessionController: controller, copyText: async () => result });
    assert.equal((await commands.execute("/copy")).status, "handled");
    assert.equal(presenter.notices.some((notice) => notice.tone === "success"), false);
    assert.ok(presenter.notices.length > 0);
  }
});

test("terminal commands show the name and keep OSC 52 out of the transcript", async (t) => {
  const controller = await controllerFixture(t);
  const answer = "## Markdown\n\n原始正文\n";
  assistant(controller, [{ type: "text", text: answer }]);
  const driver = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver });
  t.after(() => ui.close());
  const { commands } = createSessionCommandFixture({
    presenter: new TerminalCommandPresenter(ui), sessionController: controller,
    copyText: (text) => copyText(text, {
      platform: "linux", environ: { SSH_TTY: "/dev/fixture", TERM: "xterm-256color" }, isTTY: true,
      run: async () => { throw new Error("SSH must not use a native clipboard"); },
      writeTerminal: (sequence) => driver.write(sequence),
    }),
  });
  ui.setCommandRegistry(commands.registry);
  ui.startLoop(() => {});
  assert.equal((await commands.execute("/name 终端测试")).status, "handled");
  assert.equal((await commands.execute("/session")).status, "handled");
  assert.equal((await commands.execute("/copy")).status, "handled");
  ui.drainLoop();
  const encoded = Buffer.from(answer).toString("base64");
  assert.ok(driver.writes().includes(`\x1b]52;c;${encoded}\x07`));
  const transcript = stripTerminalControls(ui.buildHistoryLines(120).join("\n"));
  assert.match(transcript, /Name: 终端测试/);
  assert.match(transcript, /Copy request sent to terminal/);
  assert.equal(transcript.includes(encoded), false);
  assert.equal(transcript.includes("Copied assistant text to clipboard"), false);
  for (const state of ["IDLE", "RUNNING_MODEL", "RUNNING_TOOLS", "CANCELLING", "FAILED"]) {
    const names = commands.registry.complete("/", { state }).map((item) => item.value);
    assert.ok(names.includes("/name"));
    assert.ok(names.includes("/copy"));
  }
});
