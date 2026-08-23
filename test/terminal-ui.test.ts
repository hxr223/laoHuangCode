import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BasicEditorState,
  BasicInputDecoder,
  PlainEventSink,
  StdTerminalDriver,
  TerminalUI,
  type CommandRegistryLike,
  type LoopInputSource,
} from "../src/terminal/ui.ts";
import { makeToggleToolOutputDisplayAction } from "../src/ui/display-actions.ts";
import {
  MemoryTerminalDriver,
  PiMainScreenRenderer,
  stripTerminalControls,
  visibleWidth,
} from "../src/terminal/screen.ts";
import { TerminalEmulator } from "./helpers/terminal-emulator.ts";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function event(
  kind: string,
  correlationId: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, correlation_id: correlationId, payload };
}

/** Minimal slash-command registry double matching CommandRegistry.complete. */
function createRegistry(
  specs: Array<{ name: string; description: string }>,
): CommandRegistryLike {
  return {
    complete(text: string, _options: { state: string }) {
      if (!text.startsWith("/") || text.includes("\n")) {
        return [];
      }
      if (!text.includes(" ")) {
        return specs
          .filter((spec) => spec.name.startsWith(text))
          .map((spec) => ({
            value: spec.name,
            description: spec.description,
            start: -text.length,
          }));
      }
      return [];
    },
  };
}

test("loop preserves first turn while second response streams", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  const submitted: string[] = [];

  ui.startLoop((text) => {
    submitted.push(text);
  });
  ui.feedInputBytes(bytes("first\r"));
  ui.publishEvent(event("model.text_delta", "r1", { text: "answer one" }));
  ui.publishEvent(event("model.response_committed", "r1"));
  ui.feedInputBytes(bytes("second\r"));
  ui.publishEvent(event("model.text_delta", "r2", { text: "answer two" }));
  ui.drainLoop();

  assert.deepEqual(submitted, ["first", "second"]);
  assert.ok(terminal.writes().includes("first"));
  assert.ok(terminal.writes().includes("answer one"));
  assert.ok(terminal.writes().includes("answer two"));
});

test("alt enter submits a follow-up action from the live loop", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: Array<{ text: string; strategy?: string }> = [];

  ui.startLoop((text, options) => {
    submitted.push({ text, strategy: options?.strategy });
  });
  ui.feedInputBytes(bytes("later\x1b[13;3u"));
  ui.drainLoop();

  assert.deepEqual(submitted, [{ text: "later", strategy: "follow_up" }]);
});

test("enhanced shift tab reaches the reasoning cycle action", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const actions: string[] = [];
  const ui = new TerminalUI({
    driver: terminal,
    capabilities: { reasoning: true },
    keyActionCallback: (action) => {
      actions.push(action);
    },
  });

  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("\x1b[9;2u\x1b[27;2;9~"));
  ui.drainLoop();

  assert.deepEqual(actions, ["cycle_thinking", "cycle_thinking"]);
});

test("ctrl l invokes the model selection key action", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const actions: string[] = [];
  const ui = new TerminalUI({
    driver: terminal,
    keyActionCallback: (action) => {
      actions.push(action);
    },
  });

  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("\f"));
  ui.drainLoop();

  assert.deepEqual(actions, ["select_model"]);
});

test("second response does not rewrite frozen first turn bytes", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("one\r"));
  ui.publishEvent(event("model.text_delta", "r1", { text: "first answer" }));
  ui.drainLoop();
  assert.ok(terminal.writes().includes("first answer"));
  terminal.clearWrites();
  ui.publishEvent(event("model.response_committed", "r1"));
  ui.drainLoop();
  assert.ok(!terminal.writes().includes("first answer"));
  assert.ok(!terminal.writes().includes("\r\n"));

  ui.feedInputBytes(bytes("two\r"));
  ui.drainLoop();
  terminal.clearWrites();
  ui.publishEvent(event("model.text_delta", "r2", { text: "second answer" }));
  ui.drainLoop();

  assert.ok(!terminal.writes().includes("first answer"));
  assert.ok(terminal.writes().includes("second answer"));
});

test("event publication does not write before loop drains", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.publishEvent(event("ui.message", "", { text: "queued" }));

  assert.equal(terminal.writes(), "");
  ui.drainLoop();
  assert.ok(terminal.writes().includes("queued"));
});

test("terminal-local backpressure produces a dropped display marker", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});

  for (let index = 0; index < 4_100; index += 1) {
    ui.publishEvent(event("model.reasoning_delta", "request-1", {
      text: "x",
      ...(index === 4_099 ? { _projection_dropped: 5 } : {}),
    }));
  }
  ui.publishEvent(event("task.completed", "task-1"));
  ui.drainLoop();

  assert.match(ui.buildHistoryLines(80).join("\n"), /省略了 137 个流式展示事件/);
});

test("tool output is folded by default and shown by a local display toggle", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("tool.started", "call-1", { name: "bash", arguments: {} }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-1", {
    stream: "stdout",
    text: "full tool output",
  }));

  assert.ok(!ui.buildHistoryLines(80).join("\n").includes("full tool output"));
  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(true));
  assert.ok(ui.buildHistoryLines(80).join("\n").includes("full tool output"));
});

test("input bytes do not mutate before loop drains", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: string[] = [];
  ui.startLoop((text) => {
    submitted.push(text);
  });
  terminal.clearWrites();

  ui.feedInputBytes(bytes("queued input\r"));

  assert.deepEqual(submitted, []);
  assert.equal(terminal.writes(), "");
  ui.drainLoop();
  assert.deepEqual(submitted, ["queued input"]);
  assert.ok(terminal.writes().includes("queued input"));
});

test("typing updates editor line without appending prompt history", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("a"));
  ui.drainLoop();
  terminal.clearWrites();

  ui.feedInputBytes(bytes("s"));
  ui.drainLoop();

  assert.equal(terminal.writeChunks().length, 1);
  assert.ok(terminal.writes().includes("\r\x1b[2K❯ as"));
  assert.equal(terminal.writes().split("\x1b[2K").length - 1, 1);
  assert.ok(!terminal.writes().includes("\r\n"));
  assert.ok(!terminal.writes().includes("\r\n❯ a"));
});

test("typing updates editor line semantically in four rows", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 4 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 4 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("a"));
  ui.drainLoop();
  emulator.write(terminal.writes());
  terminal.clearWrites();

  ui.feedInputBytes(bytes("s"));
  ui.drainLoop();
  emulator.write(terminal.writes());

  const rendered = emulator.logicalLines.join("\n");
  assert.equal(rendered.split("❯ ").length - 1, 1);
  assert.ok(emulator.viewportLines.includes("❯ as"));
  assert.ok(!emulator.logicalLines.includes("❯ a"));
});

test("three ascii keystrokes leave cursor after third character", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 4 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 4 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  ui.startLoop(() => {});
  emulator.write(terminal.writes());
  terminal.clearWrites();

  for (const char of "asd") {
    ui.feedInputBytes(bytes(char));
    ui.drainLoop();
    emulator.write(terminal.writes());
    terminal.clearWrites();
  }

  assert.deepEqual(emulator.viewportLines.slice(0, 3), [
    "─".repeat(80),
    "❯ asd",
    "─".repeat(80),
  ]);
  assert.equal(emulator.cursorRow, 1);
  assert.equal(emulator.cursorColumn, 5);
  assert.equal(emulator.logicalLines.join("\n").split("❯ ").length - 1, 1);
});

test("two completed turns remain in history without tail truncation", () => {
  const ui = new TerminalUI({ theme: "light" });
  ui.acceptUserInput("first question");
  ui.applyProjectedEvent(event("model.text_delta", "r1", { text: "first answer" }));
  ui.applyProjectedEvent(event("model.response_committed", "r1"));
  ui.acceptUserInput("second question");
  ui.applyProjectedEvent(event("model.text_delta", "r2", { text: "second answer" }));

  const rendered = ui.buildHistoryLines(80).join("\n");
  assert.ok(rendered.includes("first question"));
  assert.ok(rendered.includes("first answer"));
  assert.ok(rendered.includes("second question"));
  assert.ok(rendered.includes("second answer"));
});

test("second request cannot mutate frozen first response", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("model.text_delta", "r1", { text: "one" }));
  ui.applyProjectedEvent(event("model.response_committed", "r1"));
  ui.applyProjectedEvent(event("model.text_delta", "r2", { text: "two" }));

  assert.equal(ui.blockFor("assistant", "r1").text, "one");
  assert.equal(ui.blockFor("assistant", "r2").text, "two");
});

test("frame active start includes mutable response", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("model.text_delta", "r1", { text: "one" }));

  const frame = ui.buildFrame({ width: 80, editor: new BasicEditorState() });

  assert.ok((frame.lines[frame.activeStart] as string).includes("one"));
});

test("raw frame preserves non-markdown block styles", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "plan" }));
  ui.applyProjectedEvent(event("tool.started", "tool-1", { name: "bash" }));

  const rendered = ui.buildHistoryLines(80).join("\n");

  assert.ok(rendered.includes("\x1b[3;38;2;128;128;128mthinking  plan"));
  assert.ok(rendered.includes("\x1b[48;2;40;40;50;38;2;212;212;212m"));
  assert.ok(rendered.includes("● bash"));
});

test("tool start freezes superseded reasoning", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "plan" }));
  ui.applyProjectedEvent(event("tool.started", "tool-1", { name: "bash" }));
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: " late" }));

  assert.equal(ui.blockFor("thinking", "r1").text, "plan");
});

test("text response freezes superseded reasoning", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "plan" }));
  ui.applyProjectedEvent(event("model.text_delta", "r1", { text: "answer" }));
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: " late" }));

  assert.equal(ui.blockFor("thinking", "r1").text, "plan");
});

test("plain sink outputs one complete model response", () => {
  const output: string[] = [];
  const sink = new PlainEventSink((text) => {
    output.push(text);
  });
  const base = {
    source: "model",
    session_id: "session-1",
    task_id: "task-1",
    correlation_id: "request-1",
    sequence: 1,
  };
  sink.publishEvent({ ...base, kind: "model.text_delta", payload: { text: "hello " } });
  sink.publishEvent({ ...base, kind: "model.text_delta", payload: { text: "world" } });
  sink.publishEvent({ ...base, kind: "model.response_committed", payload: {} });
  sink.flush();
  sink.stop();

  assert.deepEqual(output, ["hello world"]);
});

test("raw loop owns transcript and editor together", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ theme: "light", driver: terminal });
  const submitted: string[] = [];

  ui.showWelcome();
  ui.startLoop((text) => {
    submitted.push(text);
  });
  ui.feedInputBytes(bytes("hello\r"));
  ui.drainLoop();

  assert.deepEqual(submitted, ["hello"]);
  assert.ok(terminal.writes().includes("laoHuangCode"));
  assert.ok(terminal.writes().includes("hello"));
});

test("raw loop stays in the regular terminal screen", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });

  ui.startLoop(() => {});
  ui.drainLoop();
  ui.requestExit();

  assert.ok(!terminal.writes().includes("\x1b[?1049h"));
  assert.ok(!terminal.writes().includes("\x1b[2J"));
});

test("raw loop bracketed paste lifecycle writes start and close", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });

  ui.startLoop(() => {});
  assert.ok(terminal.writes().includes("\x1b[?2004h"));

  ui.close();

  assert.ok(terminal.writes().includes("\x1b[?2004l"));
});

test("raw loop restores modify other keys on close", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  terminal.clearWrites();

  ui.feedInputBytes(bytes("\x1b[?1;2c"));
  ui.drainLoop();
  assert.ok(terminal.writes().includes("\x1b[>4;2m"));

  terminal.clearWrites();
  ui.close();

  assert.ok(terminal.writes().includes("\x1b[>4;0m"));
});

test("raw loop split paste submits multiline content only", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: string[] = [];
  ui.startLoop((text) => {
    submitted.push(text);
  });

  ui.feedInputBytes(bytes("\x1b[200~one\n"));
  ui.drainLoop();
  ui.feedInputBytes(bytes("two\x1b[201~"));
  ui.drainLoop();
  ui.feedInputBytes(bytes("\r"));
  ui.drainLoop();

  assert.deepEqual(submitted, ["one\ntwo"]);
  assert.ok(!terminal.writes().includes("[200~"));
  assert.ok(!terminal.writes().includes("[201~"));
});

test("raw loop apple shift enter uses native shift detector", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const submitted: string[] = [];
  const ui = new TerminalUI({
    driver: terminal,
    decoderFactory: (hooks) =>
      new BasicInputDecoder(hooks, {
        isAppleTerminal: () => true,
        shiftPressed: () => true,
      }),
  });
  ui.startLoop((text) => {
    submitted.push(text);
  });
  ui.feedInputBytes(bytes("\r"));
  ui.drainLoop();

  assert.deepEqual(submitted, []);
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  assert.equal(loop?.editor.text, "\n");
});

test("run enters raw mode before keyboard protocol query", async () => {
  class OrderedDriver extends MemoryTerminalDriver {
    readonly events: string[] = [];

    enterRawMode(): void {
      this.events.push("raw");
    }

    override write(data: string): void {
      if (data.includes("\x1b[>7u\x1b[?u\x1b[c")) {
        this.events.push("query");
      }
      super.write(data);
    }
  }

  const terminal = new OrderedDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  loop.start(() => {});
  loop.requestExit();
  await loop.run({ on: () => {} });

  assert.ok(terminal.events.indexOf("raw") < terminal.events.indexOf("query"));
});

test("raw loop goodbye uses loop writer not fallback output", () => {
  const stream: string[] = [];
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({
    output: (text) => {
      stream.push(text);
    },
    driver: terminal,
  });
  ui.startLoop(() => {});

  ui.showGoodbye();

  assert.deepEqual(stream, []);
  assert.ok(terminal.writes().includes("Goodbye."));
});

test("closed raw loop error falls back to plain output", () => {
  const stream: string[] = [];
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({
    output: (text) => {
      stream.push(text);
    },
    driver: terminal,
  });
  ui.startLoop(() => {});
  ui.close();

  ui.showError("shutdown failed");

  assert.ok(stream.join("\n").includes("Error: shutdown failed"));
});

test("raw loop ignores a repeated exit request", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });

  ui.startLoop(() => {});
  ui.requestExit();
  ui.requestExit();
  ui.drainLoop();

  assert.equal(ui.renderError, null);
});

test("raw loop keeps command completion compact", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const registry = createRegistry([{ name: "/exit", description: "退出程序" }]);
  const ui = new TerminalUI({ driver: terminal, commandRegistry: registry });

  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("/e"));
  ui.drainLoop();

  const completionLines = terminal
    .writes()
    .split("\r\n")
    .filter((line) => line.includes("/exit"));
  assert.equal(completionLines.length, 1);
});

test("frame uses only content rows for a completion", () => {
  const registry = createRegistry([{ name: "/exit", description: "退出程序" }]);
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
    commandRegistry: registry,
    model: "deepseek-v4-flash",
  });
  const editor = new BasicEditorState();
  editor.apply({ kind: "insert", text: "/e" }, { runtimeActive: false });
  editor.setCompletions(registry.complete(editor.text, { state: "IDLE" }));
  const frame = ui.buildFrame({ width: 80, editor });

  assert.equal(frame.lines.filter((line) => line.includes("/exit")).length, 1);
  assert.ok((frame.lines[frame.lines.length - 1] as string).includes("deepseek-v4-flash"));
});

test("frame lines fit visible width with cjk content", () => {
  const registry = createRegistry([
    {
      name: "/extralong",
      description: "说明说明说明 very long completion description",
    },
  ]);
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 20, rows: 8 }),
    commandRegistry: registry,
    provider: "deepseek",
    model: "deepseek-v4-flash-extra-long",
  });
  ui.acceptUserInput("你好abc你好abc你好abc");
  const editor = new BasicEditorState();
  editor.apply({ kind: "insert", text: "/e" }, { runtimeActive: false });
  editor.setCompletions(registry.complete(editor.text, { state: "IDLE" }));

  const frame = ui.buildFrame({ width: 20, editor });

  assert.ok(frame.lines.length > 0);
  assert.ok(frame.lines.every((line) => visibleWidth(line) <= 20));
});

test("tool card lines fit visible width with styled text", () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 18, rows: 8 }),
  });
  ui.applyProjectedEvent(
    event("tool.started", "tool-1", {
      name: "bash",
      arguments: { command: "echo 你好你好你好你好" },
    }),
  );

  const frame = ui.buildFrame({ width: 18, editor: new BasicEditorState() });

  assert.ok(frame.lines.length > 0);
  assert.ok(frame.lines.every((line) => visibleWidth(line) <= 18));
});

test("completion shrink clears stale rows without clearing scrollback", () => {
  const terminal = new MemoryTerminalDriver({ columns: 40, rows: 4 });
  const emulator = new TerminalEmulator({ columns: 40, rows: 4 });
  const registry = createRegistry([
    { name: "/exit", description: "退出程序" },
    { name: "/help", description: "show help" },
    { name: "/model", description: "choose model" },
  ]);
  const ui = new TerminalUI({ driver: terminal, commandRegistry: registry });
  ui.acceptUserInput("saved scrollback");
  const renderer = new PiMainScreenRenderer(terminal);
  const editor = new BasicEditorState();
  editor.apply({ kind: "insert", text: "/" }, { runtimeActive: false });
  editor.setCompletions(registry.complete(editor.text, { state: "IDLE" }));
  renderer.render(ui.buildFrame({ width: 40, editor }));
  emulator.write(terminal.writes());
  terminal.clearWrites();
  assert.ok(emulator.logicalLines.join("\n").includes("saved scrollback"));

  editor.apply({ kind: "insert", text: "h" }, { runtimeActive: false });
  editor.setCompletions(registry.complete(editor.text, { state: "IDLE" }));
  renderer.render(ui.buildFrame({ width: 40, editor }));
  emulator.write(terminal.writes());

  const rendered = emulator.logicalLines.join("\n");
  const viewport = emulator.viewportLines.join("\n");
  assert.ok(rendered.includes("saved scrollback"));
  assert.ok(viewport.includes("/help"));
  assert.ok(!viewport.includes("/exit"));
  assert.ok(!viewport.includes("/model"));
});

test("frame grows only for actual multiline input", () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
  });
  const editor = new BasicEditorState();
  editor.apply(
    { kind: "insert", text: "first line\nsecond line" },
    { runtimeActive: false },
  );
  const frame = ui.buildFrame({ width: 80, editor });

  assert.ok(frame.lines.includes("❯ first line"));
  assert.ok(frame.lines.includes("  second line"));
  assert.equal(
    frame.lines.filter(
      (line) => line.includes("first line") || line.includes("second line"),
    ).length,
    2,
  );
});

test("raw loop reuses editor for command questions", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});

  const answerPromise = ui.prompt("Select model:");
  ui.drainLoop();
  ui.feedInputBytes(bytes("1\r"));
  ui.drainLoop();

  assert.equal(await answerPromise, "1");
  assert.ok(terminal.writes().includes("Select model:"));
});

test("single renderer keeps stream text across tool boundaries", () => {
  const ui = new TerminalUI({ theme: "light" });
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "thinking" }));
  ui.applyProjectedEvent(
    event("tool.started", "tool-1", {
      name: "bash",
      arguments: { command: "ls -la" },
    }),
  );
  ui.applyProjectedEvent(
    event("tool.finished", "tool-1", {
      status: "completed",
      exit_code: 0,
      duration_ms: 1,
    }),
  );
  ui.applyProjectedEvent(
    event("model.text_delta", "r2", { text: "`laoHuangCode` 项目根目录" }),
  );

  const rendered = stripTerminalControls(ui.buildHistoryLines(60).join("\n"));
  assert.ok(rendered.includes("laoHuangCode 项目根目录"));
  assert.ok(!rendered.includes("`"));
  assert.ok(rendered.includes("completed · exit 0 · 1ms"));
  assert.ok(!rendered.includes("very long output"));
});

test("single renderer renders assistant markdown", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(
    event("model.text_delta", "response-1", {
      text: "**加粗**、`代码`\n\n- 第一项",
    }),
  );

  const lines = ui.buildHistoryLines(80);
  const rendered = lines.join("\n");

  assert.ok(rendered.includes("加粗"));
  assert.ok(rendered.includes("代码"));
  assert.ok(rendered.includes("第一项"));
  assert.ok(!rendered.includes("**"));
  assert.ok(!rendered.includes("`"));
  assert.ok(lines.some((line) => line.includes("\x1b[1m") && line.includes("加粗")));
  assert.ok(lines.some((line) => line.includes("48;2") && line.includes("代码")));
});

test("assistant response is rendered as markdown without chat prefix", () => {
  const stream: string[] = [];
  const ui = new TerminalUI({
    output: (text) => {
      stream.push(text);
    },
  });

  ui.showAssistant("**Fixed** `calculator.py`");

  const rendered = stream.join("\n");
  assert.ok(rendered.includes("Fixed"));
  assert.ok(rendered.includes("calculator.py"));
  assert.ok(!rendered.includes("laoHuangCode>"));
});

test("event sinks hide stdout but render stderr and status", () => {
  const base = {
    source: "tool",
    session_id: "session-1",
    task_id: "task-1",
    sequence: 1,
  };
  const events = [
    { ...base, kind: "tool.started", correlation_id: "call-1", payload: { name: "bash" } },
    {
      ...base,
      kind: "tool.output_delta",
      correlation_id: "call-1",
      payload: { stream: "stdout", text: "very long output" },
    },
    {
      ...base,
      kind: "tool.output_delta",
      correlation_id: "call-1",
      payload: { stream: "stderr", text: "warning\n" },
    },
    {
      ...base,
      kind: "tool.finished",
      correlation_id: "call-1",
      payload: { status: "completed", exit_code: 0 },
    },
  ];

  const plainOutput: string[] = [];
  const plain = new PlainEventSink((text) => {
    plainOutput.push(text);
  });
  for (const item of events) {
    plain.publishEvent(item);
  }
  plain.flush();
  plain.stop();

  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  for (const item of events) {
    ui.publishEvent(item);
  }
  ui.drainLoop();

  const plainRendered = plainOutput.join("\n");
  const terminalRendered = terminal.writes();
  for (const rendered of [plainRendered, terminalRendered]) {
    assert.ok(!rendered.includes("very long output"));
    assert.ok(rendered.includes("warning"));
    assert.ok(rendered.includes("completed"));
  }
});

test("welcome panel shows session context", () => {
  const stream: string[] = [];
  const ui = new TerminalUI({
    output: (text) => {
      stream.push(text);
    },
    projectRoot: "/tmp/demo",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    dashboardUrl: "http://127.0.0.1:8765/",
  });

  ui.showWelcome();

  const rendered = stream.join("\n");
  assert.ok(rendered.includes("laoHuangCode"));
  assert.ok(rendered.includes("/tmp/demo"));
  assert.ok(rendered.includes("deepseek/deepseek-v4-pro"));
  assert.ok(rendered.includes("http://127.0.0.1:8765/"));
});

/** Scriptable stdin double for the production run() loop. */
class FakeInputSource implements LoopInputSource {
  #dataHandlers: Array<(data: Uint8Array) => void> = [];
  #endHandlers: Array<() => void> = [];

  on(event: "data" | "end", listener: (...args: never[]) => void): void {
    if (event === "data") {
      this.#dataHandlers.push(listener as (data: Uint8Array) => void);
    } else {
      this.#endHandlers.push(listener as () => void);
    }
  }

  off(event: "data" | "end", listener: (...args: never[]) => void): void {
    if (event === "data") {
      this.#dataHandlers = this.#dataHandlers.filter((handler) => handler !== listener);
    } else {
      this.#endHandlers = this.#endHandlers.filter((handler) => handler !== listener);
    }
  }

  emitData(data: Uint8Array): void {
    for (const handler of [...this.#dataHandlers]) {
      handler(data);
    }
  }

  pauseCount = 0;

  pause(): void {
    this.pauseCount += 1;
  }

  emitEnd(): void {
    for (const handler of [...this.#endHandlers]) {
      handler();
    }
  }
}

test("run restores raw mode and pauses stdin on exit", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  const input = new FakeInputSource();
  const done = loop.run(input);

  input.emitEnd();
  await done;

  // A still-flowing stdin keeps the event loop alive forever; raw mode left
  // on leaks into the user's shell after exit.
  assert.equal(input.pauseCount, 1);
  assert.ok(terminal.restoreCalls >= 1);
});

test("run exits when stdin ends with an idle empty editor", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  const input = new FakeInputSource();
  let finished = false;
  const done = loop.run(input).then(() => {
    finished = true;
  });

  input.emitEnd();
  await done;

  assert.ok(finished);
});

test("run shows a notice and keeps running when stdin ends mid-draft", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  const input = new FakeInputSource();
  let finished = false;
  const done = loop.run(input).then(() => {
    finished = true;
  });
  try {
    input.emitData(bytes("draft"));
    input.emitEnd();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(finished, false);
    assert.ok(terminal.writes().includes("Clear the editor before exiting."));
  } finally {
    loop.requestExit();
    await done;
  }
});

test("run renders published events without waiting for stdin", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  const input = new FakeInputSource();
  const done = loop.run(input);
  try {
    ui.publishEvent(event("model.text_delta", "r1", { text: "streaming answer" }));
    // No drain() and no stdin bytes: the production wakeup (the Python
    // selector loop's wakeup-pipe role) must render the delta anyway.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(terminal.writes().includes("streaming answer"));
  } finally {
    loop.requestExit();
    await done;
  }
});

test("publishEvent does not auto-render outside run (drain stays the test hook)", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  ui.publishEvent(event("model.text_delta", "r1", { text: "queued only" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!terminal.writes().includes("queued only"));
  loop.drain();
  assert.ok(terminal.writes().includes("queued only"));
});

/** Replace process.stdout.columns for the duration of `run`. */
function withStdoutColumns<T>(columns: number | undefined, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", {
    value: columns,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (descriptor !== undefined) {
      Object.defineProperty(process.stdout, "columns", descriptor);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
  }
}

test("showAssistant wraps fallback markdown to the actual terminal width", () => {
  withStdoutColumns(40, () => {
    const stream: string[] = [];
    const ui = new TerminalUI({
      output: (text) => {
        stream.push(text);
      },
    });

    ui.showAssistant(
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi",
    );

    const widths = stream.map((line) => visibleWidth(line));
    assert.ok(widths.length > 1);
    assert.ok(widths.every((width) => width <= 40));
  });
});

test("showAssistant falls back to 80 columns when terminal width is unknown", () => {
  withStdoutColumns(undefined, () => {
    const stream: string[] = [];
    const ui = new TerminalUI({
      output: (text) => {
        stream.push(text);
      },
    });

    ui.showAssistant("lorem ipsum dolor sit amet ".repeat(8).trim());

    const widths = stream.map((line) => visibleWidth(line));
    assert.ok(widths.length > 1);
    assert.ok(widths.every((width) => width <= 80));
    assert.ok(widths.some((width) => width > 40));
  });
});

test("StdTerminalDriver tees escaped writes to LAOHUANG_DEBUG_LOG", () => {
  const dir = mkdtempSync(join(tmpdir(), "laohuang-debug-"));
  const logPath = join(dir, "debug.log");
  const savedEnv = process.env.LAOHUANG_DEBUG_LOG;
  const savedWrite = process.stdout.write;
  process.env.LAOHUANG_DEBUG_LOG = logPath;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const driver = new StdTerminalDriver();
    driver.write("\x1b[2K❯ hi\r\n");
  } finally {
    process.stdout.write = savedWrite;
    if (savedEnv === undefined) {
      delete process.env.LAOHUANG_DEBUG_LOG;
    } else {
      process.env.LAOHUANG_DEBUG_LOG = savedEnv;
    }
  }

  const captured = readFileSync(logPath, "utf8");
  assert.ok(captured.includes("\\x1b[2K"));
  assert.ok(captured.includes("❯ hi"));
  assert.ok(captured.includes("\\r"));
});

test("StdTerminalDriver creates no debug file when LAOHUANG_DEBUG_LOG is unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "laohuang-debug-"));
  const logPath = join(dir, "debug.log");
  const savedEnv = process.env.LAOHUANG_DEBUG_LOG;
  const savedWrite = process.stdout.write;
  delete process.env.LAOHUANG_DEBUG_LOG;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const driver = new StdTerminalDriver();
    driver.write("\x1b[2Knot captured\r\n");
    assert.ok(!existsSync(logPath));
  } finally {
    process.stdout.write = savedWrite;
    if (savedEnv !== undefined) {
      process.env.LAOHUANG_DEBUG_LOG = savedEnv;
    }
  }
});
