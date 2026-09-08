import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PlainEventSink,
  StdTerminalDriver,
  TerminalUI,
  type CommandRegistryLike,
  type LoopInputSource,
} from "../packages/terminal/tui/src/tui/ui.ts";
import { CompletionPopup } from "../packages/terminal/tui/src/tui/components/completion-list.ts";
import { AssistantMessage } from "../packages/terminal/tui/src/tui/components/messages/assistant-message.ts";
import { ThinkingMessage } from "../packages/terminal/tui/src/tui/components/messages/thinking-message.ts";
import { ToolMessage } from "../packages/terminal/tui/src/tui/components/messages/tool-message.ts";
import { UserMessage } from "../packages/terminal/tui/src/tui/components/messages/user-message.ts";
import { StatusLine } from "../packages/terminal/tui/src/tui/components/status-line.ts";
import { ToolCard } from "../packages/terminal/tui/src/tui/components/tool-card.ts";
import { Transcript } from "../packages/terminal/tui/src/tui/components/transcript.ts";
import { AuthDialog } from "../packages/terminal/tui/src/tui/components/views/auth-dialog.ts";
import { EffortSelectorView } from "../packages/terminal/tui/src/tui/components/views/effort-selector.ts";
import { HelpView } from "../packages/terminal/tui/src/tui/components/views/help-view.ts";
import { ModelSelectorView } from "../packages/terminal/tui/src/tui/components/views/model-selector.ts";
import { ProviderStatusView } from "../packages/terminal/tui/src/tui/components/views/provider-status-view.ts";
import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";
import { FrameBuilder } from "../packages/terminal/tui/src/tui/frame-builder.ts";
import {
  lineText,
  type RenderContext,
  type SpanStyle,
  type StyledLine,
} from "../packages/terminal/tui/src/tui/render-model.ts";
import { createUIState } from "../packages/terminal/tui/src/tui/state.ts";
import {
  createAssistantBlock,
  createThinkingBlock,
  createToolBlock,
  createUserBlock,
  createWelcomeBlock,
  TranscriptStore,
} from "../packages/terminal/tui/src/tui/transcript-store.ts";
import {
  projectTranscript,
  type RestoredTranscriptItem,
} from "@laohuang/session-store";
import { TerminalInputDecoder } from "../packages/terminal/tui/src/tui/terminal-input-decoder.ts";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  type TerminalTheme,
} from "../packages/terminal/tui/src/tui/theme.ts";
import { makeToggleToolOutputDisplayAction } from "../packages/terminal/tui/src/tui/display-actions.ts";
import { ToolOutputRedactor } from "../packages/terminal/tui/src/tui/display-policy.ts";
import { TerminalCommandPresenter } from "../apps/cli/src/terminal-command-presenter.ts";
import { SessionCommands } from "../apps/cli/src/commands.ts";
import { ModelSelector } from "../apps/cli/src/model-selection.ts";
import { ProviderAuthController } from "../apps/cli/src/provider-auth.ts";
import {
  runSessionRepl,
  type SessionReplSession,
  type SessionUiLike,
} from "../apps/cli/src/repl.ts";
import {
  MemoryTerminalDriver,
  MainScreenRenderer,
  stripTerminalControls,
  visibleWidth,
} from "../packages/terminal/tui/src/tui/screen.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";
import {
  createSessionCommandFixture,
  FakeAgent,
  FakeCatalog,
} from "./helpers/session-command-fixture.ts";
import { TerminalEmulator } from "./helpers/terminal-emulator.ts";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

async function drainUntil(ui: TerminalUI, predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 30 && !predicate(); index += 1) {
    ui.drainLoop();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  ui.drainLoop();
}

function event(
  kind: string,
  correlationId: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, correlation_id: correlationId, payload };
}

type SemanticSnapshot = Array<Array<{ text: string; style?: SpanStyle }>>;

function semanticSnapshot(
  component: { render(context: RenderContext): { lines: readonly StyledLine[] } },
  width: number,
  theme: TerminalTheme,
): SemanticSnapshot {
  return component.render({ width, theme }).lines.map((value) =>
    value.spans.flatMap((item) => {
      const text = item.text.trim();
      if (!text) {
        return [];
      }
      return [item.style === undefined ? { text } : { text, style: item.style }];
    }),
  );
}

function structuredStyleComponents() {
  const auth = new AuthDialog({
    request: { id: "key", kind: "secret", message: "Enter API key" },
    onSubmit: () => {},
    onCancel: () => {},
  });
  auth.focused = true;
  auth.handleInput({ type: "text", text: "abc" });
  const model = new ModelSelectorView({
    title: "Models",
    currentValue: "deepseek-v4-flash",
    items: [{
      value: "deepseek-v4-flash",
      label: "deepseek-v4-flash",
      description: "DeepSeek",
    }],
    onSelect: () => {},
    onCancel: () => {},
  });
  model.focused = true;
  const effort = new EffortSelectorView({
    title: "Effort",
    currentValue: "high",
    items: [{ value: "high", label: "High" }],
    onSelect: () => {},
    onCancel: () => {},
  });
  effort.focused = true;
  return [
    new HelpView({
      commands: [{
        name: "/model",
        usage: "/model [provider] [model]",
        description: "Select model",
      }],
    }),
    new ProviderStatusView({
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        available: true,
        configured: true,
        verified: false,
        source: "stored credential",
      }],
    }),
    model,
    effort,
    auth,
    new ThinkingMessage({ text: "inspect" }),
    new ToolMessage({
      name: "bash",
      subject: "$ echo hello",
      status: "completed",
      exitCode: 0,
      durationMs: 12,
      stdout: "hello",
      stderr: "",
      expanded: true,
    }),
  ];
}

function expectedStructuredStyleSnapshots(width: number): SemanticSnapshot[] {
  return [
    width < 50
      ? [
        [{ text: "/model [provider] [model]" }],
        [{ text: "Select model", style: { foreground: "muted" } }],
      ]
      : [[
        { text: "/model [provider] [model]" },
        { text: "Select model", style: { foreground: "muted" } },
      ]],
    width < 50
      ? [
        [{ text: "DeepSeek" }],
        [{ text: "available" }],
        [{ text: "configured", style: { foreground: "success" } }],
        [{ text: "unverified", style: { foreground: "warning" } }],
        [{ text: "stored credential", style: { foreground: "muted" } }],
      ]
      : [
        [
          { text: "DeepSeek" },
          { text: "available" },
          { text: "configured", style: { foreground: "success" } },
          { text: "unverified", style: { foreground: "warning" } },
        ],
        [{ text: "stored credential", style: { foreground: "muted" } }],
      ],
    [
      [{ text: "Models", style: { foreground: "accent" } }],
      [],
      [
        { text: "❯", style: { foreground: "accent" } },
        { text: "Search models", style: { foreground: "muted" } },
      ],
      [],
      width < 50
        ? [
          { text: "→", style: { foreground: "accent" } },
          { text: "deepseek-v4-flash", style: { foreground: "accent" } },
        ]
        : [
          { text: "→", style: { foreground: "accent" } },
          { text: "deepseek-v4-flash", style: { foreground: "accent" } },
          { text: "DeepSeek", style: { foreground: "muted" } },
        ],
      [],
      [{ text: "DeepSeek", style: { foreground: "muted" } }],
    ],
    [
      [{ text: "Effort", style: { foreground: "accent" } }],
      [],
      [
        { text: "→", style: { foreground: "accent" } },
        { text: "High", style: { foreground: "accent" } },
      ],
    ],
    [
      [],
      [{ text: "Authentication", style: { foreground: "accent" } }],
      [],
      [{ text: "Enter API key" }],
      [],
      [
        { text: "❯", style: { foreground: "accent" } },
        { text: "•••" },
      ],
      [],
      [{
        text: "Enter to submit, Esc to cancel",
        style: { foreground: "dim" },
      }],
      [],
    ],
    [[{ text: "thinking  inspect", style: { foreground: "thinking", italic: true } }]],
    [
      [
        { text: "● bash", style: { foreground: "success" } },
        { text: "$ echo hello", style: { foreground: "bash" } },
      ],
      [{ text: "completed · exit 0 · 12ms" }],
      [{ text: "hello" }],
    ],
  ];
}

test("structured component style snapshots stay semantic across themes and widths", () => {
  for (const width of [40, 80]) {
    const expected = expectedStructuredStyleSnapshots(width);
    for (const theme of [DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME]) {
      assert.deepEqual(
        structuredStyleComponents().map((component) =>
          semanticSnapshot(component, width, theme)
        ),
        expected,
      );
    }
  }

  const userSpans = new UserMessage({ text: "ordinary input" })
    .render({ width: 40, theme: DEFAULT_DARK_THEME }).lines.flatMap((value) => value.spans);
  const answerSpans = new AssistantMessage({ text: "ordinary answer" })
    .render({ width: 40, theme: DEFAULT_DARK_THEME }).lines.flatMap((value) => value.spans);
  assert.ok(userSpans.some((item) =>
    item.text.includes("ordinary input") && item.style?.foreground === undefined
  ));
  assert.ok(answerSpans.some((item) =>
    item.text.includes("ordinary answer") && item.style?.foreground === undefined
  ));
});

test("completion popup is a focusable structured width-bounded component", () => {
  const popup = new CompletionPopup({
    items: [
      { value: "/help", description: "Show help", start: -5 },
      { value: "/model", description: "Switch model", start: -6 },
    ],
    selectedIndex: 1,
  });

  const rendered = popup.render({ width: 20, theme: DEFAULT_DARK_THEME });

  assert.deepEqual(rendered.lines.map(lineText), [
    "  /help  Show help",
    "› /model  Switch mod",
  ]);
  assert.equal(visibleWidth(lineText(rendered.lines[1]!)), 20);
  assert.equal(popup.focused, false);
  popup.focused = true;
  assert.equal(popup.focused, true);
});

test("completion height follows actual candidates and uses structured selection styling", () => {
  const popup = new CompletionPopup({
    items: [
      { value: "/help", description: "查看帮助", start: 0 },
      { value: "/model", description: "选择模型", start: 0 },
    ],
    selectedIndex: 0,
  });

  const rendered = popup.render({ width: 40, theme: DEFAULT_DARK_THEME });
  const first = rendered.lines[0]!;
  const second = rendered.lines[1]!;

  assert.equal(rendered.lines.length, 2);
  assert.equal(first.spans[0]?.style?.foreground, "accent");
  assert.equal(first.spans.at(-1)?.style?.foreground, "muted");
  assert.equal(second.spans[0]?.style?.foreground, undefined);
  assert.equal(second.spans.at(-1)?.style?.foreground, "muted");
  assert.deepEqual(rendered.lines.map(lineText), [
    "› /help  查看帮助",
    "  /model  选择模型",
  ]);
});

test("status line dims metadata while provider and model use terminal default", () => {
  const state = createUIState();
  state.pendingCount = 1;
  state.contextTokens = 512;
  state.contextWindow = 8192;
  state.provider = "openai";
  state.model = "gpt-test";
  const rendered = new StatusLine({
    state,
    cwd: "/worktree",
    effort: "high",
  }).render({ width: 100, theme: DEFAULT_DARK_THEME });
  const spans = rendered.lines[0]?.spans ?? [];

  assert.equal(spans.find((item) => item.text.includes("context: 6.3% (512/8.2K)"))?.style?.foreground, "dim");
  assert.equal(spans.find((item) => item.text === "/worktree"), undefined);
  assert.equal(spans.find((item) => item.text.includes("queue"))?.style?.foreground, "dim");
  assert.equal(spans.find((item) => item.text === "openai/gpt-test")?.style, undefined);
  assert.equal(spans.find((item) => item.text === "effort high")?.style?.foreground, "dim");
});

test("frame colors the pi input prompt but leaves input text default without moving the cjk cursor", () => {
  const ui = new TerminalUI({ theme: "dark" });
  const editor = new EditorState();
  editor.apply({ kind: "insert", text: "你好你" }, { runtimeActive: false });
  const frame = ui.buildFrame({ width: 13, editor });

  const inputStart = frame.lines.findIndex((line) =>
    stripTerminalControls(line).includes("> "),
  );
  const inputLine = frame.lines[inputStart];

  assert.notEqual(inputStart, -1);
  assert.ok(inputLine!.includes(DEFAULT_DARK_THEME.sgr("accent")));
  assert.ok(!inputLine!.includes(DEFAULT_DARK_THEME.sgr("text")));
  assert.equal(stripTerminalControls(inputLine!), "│> 你好你  │");
  assert.equal(frame.cursorCol, 9);
  assert.ok(frame.lines.every((line) => visibleWidth(line) <= 12));
});

test("tool card renders status metadata and expanded output inside width", () => {
  const ui = new TerminalUI({ theme: "dark" });
  const card = new ToolCard({
    block: {
      ...createToolBlock("call-12345678", {
        name: "bash",
        subject: "echo hello",
        status: "completed",
        expanded: true,
      }),
      mutable: false,
      exitCode: 0,
      durationMs: 42,
      stdout: "hello from stdout",
    },
  });

  const lines = card.render({ width: 32, theme: ui.theme }).lines;
  const rendered = lines.map(lineText).join("\n");

  assert.ok(rendered.includes("bash"));
  assert.ok(rendered.includes("completed"));
  assert.ok(rendered.includes("exit 0"));
  assert.ok(rendered.includes("42ms"));
  assert.ok(rendered.includes("hello from stdout"));
  assert.ok(lines.every((line) => visibleWidth(lineText(line)) <= 32));
});

test("transcript component reports the first mutable rendered row", () => {
  const ui = new TerminalUI({ theme: "dark" });
  const transcript = new Transcript({
    blocks: [
      createUserBlock("u1", "first question"),
      createAssistantBlock("r1", "streaming answer"),
    ],
  });

  const rendered = transcript.renderWithMetadata({ width: 80, theme: ui.theme });

  assert.equal(lineText(rendered.lines[1]!), "");
  assert.equal(rendered.activeStart, 2);
  assert.ok(lineText(rendered.lines[rendered.activeStart]!).includes("streaming answer"));
});

test("transcript component separates adjacent rendered blocks", () => {
  const ui = new TerminalUI({ theme: "dark" });
  const transcript = new Transcript({
    blocks: [
      createUserBlock("u1", "first question"),
      createAssistantBlock("r1", "first answer", false),
      createUserBlock("u2", "second question"),
    ],
  });

  const rendered = transcript.renderWithMetadata({ width: 80, theme: ui.theme });

  assert.equal(lineText(rendered.lines[1]!), "");
  assert.equal(lineText(rendered.lines[3]!), "");
});

test("main screen separates transcript from composer", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.acceptUserInput("first question");

  const frame = ui.buildFrame({ width: 40, editor: new EditorState() });
  const composerStart = frame.lines.findIndex((line) =>
    stripTerminalControls(line).startsWith("╭"),
  );
  const inputStart = frame.lines.findIndex((line) =>
    stripTerminalControls(line).includes("> "),
  );

  assert.notEqual(composerStart, -1);
  assert.notEqual(inputStart, -1);
  assert.equal(stripTerminalControls(frame.lines[composerStart - 1]!), "");
  assert.equal(frame.cursorRow, inputStart);
});

test("transcript component returns newline-free logical rows", () => {
  const ui = new TerminalUI({ theme: "dark" });
  const transcript = new Transcript({
    blocks: [
      createUserBlock("u1", "您好"),
      createThinkingBlock("r1", "thinking line"),
    ],
  });

  const rendered = transcript.renderWithMetadata({ width: 20, theme: ui.theme });

  assert.ok(rendered.lines.length > 0);
  assert.ok(rendered.lines.every((line) => !/[\r\n]/u.test(lineText(line))));
});

test("frame fallback projects every typed transcript block", () => {
  const transcript = new TranscriptStore();
  transcript.append(createUserBlock("u1", "question"));
  transcript.append(createAssistantBlock("a1", "answer", false));
  transcript.append(createThinkingBlock("t1", "inspect", false));
  transcript.append(createToolBlock("tool1", {
    name: "bash",
    subject: "$ pwd",
    status: "completed",
    expanded: false,
  }));
  transcript.append(createWelcomeBlock("hello", ["/help for commands"]));
  const frame = new FrameBuilder({ state: createUIState(), transcript }).build({
    width: 80,
    editor: new EditorState(),
  });
  const text = frame.screen.lines.map(stripTerminalControls).join("\n");

  assert.ok(text.includes("question"));
  assert.ok(text.includes("answer"));
  assert.ok(text.includes("inspect"));
  assert.ok(text.includes("bash"));
  assert.deepEqual(frame.welcomeBlock, ["hello", "/help for commands"]);
});

test("built screen frame never embeds physical newlines in logical rows", () => {
  const ui = new TerminalUI({
    theme: "dark",
    driver: new MemoryTerminalDriver({ columns: 40, rows: 8 }),
    capabilities: { reasoning: true },
  });
  ui.acceptUserInput("您好");
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "step one" }));

  const frame = ui.buildFrame({ width: 40, editor: new EditorState() });

  assert.ok(frame.lines.length > 0);
  assert.ok(frame.lines.every((line) => !/[\r\n]/u.test(line)));
});

test("default terminal ui editor exits on a second idle ctrl c", async () => {
  class ScriptedInput implements LoopInputSource {
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

    pause(): void {}

    emitData(data: Uint8Array): void {
      for (const handler of [...this.#dataHandlers]) {
        handler(data);
      }
    }
  }

  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  const input = new ScriptedInput();
  let finished = false;

  loop.start(() => {});
  const done = loop.run(input).then(() => {
    finished = true;
  });
  input.emitData(bytes("\x03"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(finished, false);

  input.emitData(bytes("\x03"));
  await done;

  assert.equal(finished, true);
});

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
  ui.feedInputBytes(bytes("caps\x1b[13;67u"));
  ui.feedInputBytes(bytes("press\x1b[13;3:1u"));
  ui.feedInputBytes(bytes("release\x1b[13;3:3u"));
  ui.drainLoop();

  assert.deepEqual(submitted, [
    { text: "later", strategy: "follow_up" },
    { text: "caps", strategy: "follow_up" },
    { text: "press", strategy: "follow_up" },
  ]);
});

test("ctrl s submits a steer action from the live loop", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: Array<{ text: string; strategy?: string }> = [];

  ui.setRuntimeRunningCallback(() => true);
  ui.startLoop((text, options) => {
    submitted.push({ text, strategy: options?.strategy });
  });
  ui.feedInputBytes(bytes("change direction\x13"));
  ui.feedInputBytes(bytes("\x13"));
  ui.drainLoop();

  assert.deepEqual(submitted, [
    { text: "change direction", strategy: "steer" },
    { text: "", strategy: "steer" },
  ]);
});

test("escape cancels a running task when there is no dismissible completion", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  let cancelCount = 0;
  const ui = new TerminalUI({
    driver: terminal,
    cancelCallback: () => {
      cancelCount += 1;
    },
  });

  ui.setRuntimeRunningCallback(() => true);
  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();

  assert.equal(cancelCount, 1);
});

test("escape dismisses completion before cancelling a running task", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  let cancelCount = 0;
  const ui = new TerminalUI({
    driver: terminal,
    commandRegistry: createRegistry([{ name: "/help", description: "Show help" }]),
    cancelCallback: () => {
      cancelCount += 1;
    },
  });

  ui.setRuntimeRunningCallback(() => true);
  ui.startLoop(() => {});
  ui.feedInputBytes(bytes("/h"));
  ui.drainLoop();
  assert.notDeepEqual(ui.interactiveLoop?.editor.completions, []);

  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();

  assert.equal(cancelCount, 0);
  assert.deepEqual(ui.interactiveLoop?.editor.completions, []);
});

test("enhanced shift tab does not invoke a reasoning effort action", () => {
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
  ui.feedInputBytes(bytes("\x1b[9;2u\x1b[27;2;9~\x1b[9;66u\x1b[9;2:1u\x1b[9;2:3u"));
  ui.drainLoop();

  assert.deepEqual(actions, []);
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

test("terminal ui keeps reasoning display visible by default", () => {
  const ui = new TerminalUI({ theme: "dark", capabilities: { reasoning: false } });

  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "visible log" }));

  assert.ok(ui.buildHistoryLines(80).join("\n").includes("visible log"));
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

test("terminal transcript redacts tool command and output before storage", () => {
  const privateValue = "task3-redaction-fixture";
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("tool.started", "call-secret", {
    name: "bash",
    arguments: { command: `$ deploy --api-key ${privateValue}` },
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-secret", {
    stream: "stdout",
    text: "token=task3-",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-secret", {
    stream: "stdout",
    text: "redaction-fixture\n",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-secret", {
    stream: "stderr",
    text: "Authorization: Bearer task3-",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-secret", {
    stream: "stderr",
    text: "redaction-fixture\n",
  }));

  const block = ui.blockFor("tool", "call-secret");
  assert.equal(block.kind, "tool");
  assert.ok(block.subject.includes("[REDACTED]"));
  assert.ok(block.stdout.includes("[REDACTED]"));
  assert.ok(block.stderr.includes("[REDACTED]"));
  assert.ok(!block.subject.includes(privateValue));
  assert.ok(!block.stdout.includes(privateValue));
  assert.ok(!block.stderr.includes(privateValue));
  assert.ok(!block.stdout.includes("redaction-fixture"));
  assert.ok(!block.stderr.includes("redaction-fixture"));

  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(true));
  const rendered = ui.buildHistoryLines(80).join("\n");
  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(!rendered.includes(privateValue));
  assert.ok(!rendered.includes("redaction-fixture"));
});

test("terminal transcript redacts credential aliases before storage and rendering", () => {
  const clientSecret = "task3-client-secret-fixture";
  const privateKey = "task3-private-key-fixture";
  const authorization = "task3-authorization-fixture";
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("tool.started", "call-aliases", {
    name: "bash",
    arguments: { command: `$ deploy client_secret=${clientSecret}` },
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-aliases", {
    stream: "stdout",
    text: `private_key=${privateKey}`,
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-aliases", {
    stream: "stderr",
    text: `authorization=${authorization}`,
  }));

  const block = ui.blockFor("tool", "call-aliases");
  assert.equal(block.kind, "tool");
  assert.ok(!block.subject.includes(clientSecret));
  assert.ok(!block.stdout.includes(privateKey));
  assert.ok(!block.stderr.includes(authorization));

  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(true));
  const rendered = ui.buildHistoryLines(80).join("\n");
  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(!rendered.includes(clientSecret));
  assert.ok(!rendered.includes(privateKey));
  assert.ok(!rendered.includes(authorization));
});

test("terminal transcript redacts bearer values split across output chunks", () => {
  const bearerValue = "task3-split-bearer-fixture";
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("tool.started", "call-bearer", { name: "bash", arguments: {} }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-bearer", {
    stream: "stderr",
    text: "Authorization: Bearer ",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-bearer", {
    stream: "stderr",
    text: `${bearerValue}\n`,
  }));

  const block = ui.blockFor("tool", "call-bearer");
  assert.equal(block.kind, "tool");
  assert.ok(block.stderr.includes("[REDACTED]"));
  assert.ok(!block.stderr.includes(bearerValue));

  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(true));
  const rendered = ui.buildHistoryLines(80).join("\n");
  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(!rendered.includes(bearerValue));
});

test("pending bearer redaction emits a marker for chunks without whitespace", () => {
  const redactor = new ToolOutputRedactor();

  assert.equal(
    redactor.redact("call-pending-bearer", "stderr", "Authorization: Bearer "),
    "Authorization: Bearer [REDACTED]",
  );
  assert.equal(
    redactor.redact("call-pending-bearer", "stderr", "task3-bearer-"),
    "[REDACTED]",
  );
  assert.equal(
    redactor.redact("call-pending-bearer", "stderr", "without-whitespace"),
    "[REDACTED]",
  );
  assert.equal(
    redactor.redact("call-pending-bearer", "stderr", "\nordinary stderr\n"),
    "\nordinary stderr\n",
  );
});

test("trailing empty credential assignments preserve following tool output", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("tool.started", "call-empty", { name: "bash", arguments: {} }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-empty", {
    stream: "stdout",
    text: "token=",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-empty", {
    stream: "stdout",
    text: "ordinary stdout\n",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-empty", {
    stream: "stderr",
    text: "secret=",
  }));
  ui.applyProjectedEvent(event("tool.output_delta", "call-empty", {
    stream: "stderr",
    text: "ordinary stderr\n",
  }));

  const block = ui.blockFor("tool", "call-empty");
  assert.equal(block.kind, "tool");
  assert.ok(block.stdout.includes("ordinary stdout"));
  assert.ok(block.stderr.includes("ordinary stderr"));
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

  const plainWrites = stripTerminalControls(terminal.writes());
  assert.equal(terminal.writeChunks().length, 1);
  assert.ok(plainWrites.includes("\r│> as"));
  assert.equal(terminal.writes().split("\x1b[2K").length - 1, 1);
  assert.ok(!terminal.writes().includes("\r\n"));
  assert.ok(!plainWrites.includes("\r\n> a"));
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
  assert.equal(rendered.split("> ").length - 1, 1);
  assert.ok(emulator.viewportLines.some((line) => line.includes("> as")));
  assert.ok(!emulator.logicalLines.includes("> a"));
});

test("terminal resize requests a fresh frame at the new width", () => {
  const terminal = new MemoryTerminalDriver({ columns: 40, rows: 6 });
  const emulator = new TerminalEmulator({ columns: 40, rows: 6 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  ui.startLoop(() => {});
  ui.drainLoop();
  emulator.write(terminal.writes());
  const narrow = emulator.logicalLines.find((line) => line.startsWith("╭"));

  terminal.clearWrites();
  terminal.resize({ columns: 90, rows: 6 });
  emulator.resize({ columns: 90, rows: 6 });
  ui.drainLoop();
  emulator.write(terminal.writes());
  const wide = emulator.logicalLines.find((line) => line.startsWith("╭"));

  assert.equal(visibleWidth(narrow ?? ""), 39);
  assert.equal(visibleWidth(wide ?? ""), 89);
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

  assert.ok(emulator.viewportLines.includes(`│> asd${" ".repeat(72)}│`));
  assert.equal(emulator.cursorColumn, 6);
  assert.equal(emulator.logicalLines.join("\n").split("> ").length - 1, 1);
  assert.equal(/[╭╮╰╯│]/u.test(emulator.logicalLines.join("\n")), true);
});

test("cjk typing leaves the framed hardware cursor after ten cells", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 4 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 4 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  ui.startLoop(() => {});
  emulator.write(terminal.writes());
  terminal.clearWrites();

  ui.feedInputBytes(bytes("中文abc"));
  ui.drainLoop();
  emulator.write(terminal.writes());

  assert.ok(emulator.viewportLines.includes(`│> 中文abc${" ".repeat(68)}│`));
  assert.equal(emulator.cursorColumn, 10);
  assert.equal(emulator.logicalLines.join("\n").split("> ").length - 1, 1);
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

test("terminal ui replaces transcript from restored session and continues live events", () => {
  const ui = new TerminalUI({ theme: "dark" });
  const restored: readonly RestoredTranscriptItem[] = [
    { kind: "user", text: "old question" },
    { kind: "assistant", text: "old answer", reasoning: "old thinking" },
    { kind: "tool", callId: "call-1", name: "bash", subject: "pwd", result: "ok", isError: false },
    { kind: "notice", text: "torn tail ignored", tone: "warning" },
  ];

  ui.replaceTranscript(restored);
  ui.applyProjectedEvent(event("model.text_delta", "new-response", { text: "new answer" }));
  ui.applyProjectedEvent(event("model.response_committed", "new-response"));

  const lines = ui.buildHistoryLines(80).join("\n");
  assert.match(lines, /old question/);
  assert.match(lines, /old answer/);
  assert.match(lines, /old thinking/);
  assert.match(lines, /bash/);
  assert.match(lines, /torn tail ignored/);
  assert.match(lines, /new answer/);
});

test("transcript projector restores user assistant and tool notices", () => {
  const items = projectTranscript([
    {
      schemaVersion: 1,
      sessionId: "session",
      seq: 1,
      id: "e1",
      timestamp: "2026-08-31T00:00:00.000Z",
      kind: "entry",
      entryType: "user_message",
      payload: {
        message: { role: "user", content: "hello" },
        inputEventIds: [],
        source: "direct",
      },
    },
    {
      schemaVersion: 1,
      sessionId: "session",
      seq: 2,
      id: "e2",
      timestamp: "2026-08-31T00:00:00.000Z",
      kind: "entry",
      entryType: "assistant_message",
      payload: {
        message: {
          role: "assistant",
          provider: "pi-ai",
          model: "gpt-test",
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "answer" },
            { type: "tool-call", call: { id: "call-1", name: "read", arguments: { path: "a.txt" } } },
          ],
        },
        requestId: "request-1",
        finishReason: "tool-calls",
      },
    },
    {
      schemaVersion: 1,
      sessionId: "session",
      seq: 3,
      id: "e3",
      timestamp: "2026-08-31T00:00:00.000Z",
      kind: "entry",
      entryType: "tool_result",
      payload: {
        message: {
          role: "tool-result",
          toolCallId: "call-1",
          toolName: "read",
          content: "file",
          isError: false,
        },
        requestId: "request-1",
        recovered: false,
      },
    },
  ]);

  assert.deepEqual(items, [
    { kind: "user", text: "hello" },
    { kind: "assistant", text: "answer", reasoning: "think" },
    { kind: "tool", callId: "call-1", name: "read", subject: "call-1", result: "file", isError: false },
  ]);
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

  const frame = ui.buildFrame({ width: 80, editor: new EditorState() });

  assert.ok((frame.lines[frame.activeStart] as string).includes("one"));
});

test("raw frame preserves non-markdown block styles", () => {
  const ui = new TerminalUI({ theme: "dark" });
  ui.applyProjectedEvent(event("model.reasoning_delta", "r1", { text: "plan" }));
  ui.applyProjectedEvent(event("tool.started", "tool-1", { name: "bash" }));

  const rendered = ui.buildHistoryLines(80).join("\n");

  assert.ok(rendered.includes("\x1b[3;38;2;128;128;128mthinking  plan"));
  assert.ok(!rendered.includes("\x1b[48;2;40;40;50m"));
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

test("retry schedule events render as non-terminal notices", () => {
  const output: string[] = [];
  const sink = new PlainEventSink((text) => {
    output.push(text);
  });
  const retry = event("model.retry_scheduled", "request-1", {
    attempt: 2,
    max_attempts: 3,
    delay_ms: 250,
    error_kind: "server",
  });

  sink.publishEvent({
    ...retry,
    source: "model",
    session_id: "session-1",
    task_id: "task-1",
    sequence: 1,
  });
  sink.flush();
  sink.stop();

  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ theme: "dark", driver: terminal });
  ui.applyProjectedEvent(retry);

  const expected = "Model request retry 2/3 in 250ms (server).";
  assert.deepEqual(output, [expected]);
  assert.ok(stripTerminalControls(ui.buildHistoryLines(80).join("\n")).includes(expected));
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
  assert.equal(/[╭╮╰╯│]/u.test(stripTerminalControls(terminal.writes())), true);
  assert.ok(terminal.writes().includes("Welcome to LaoHuang Code!"));
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

test("raw loop enables a blinking bar cursor", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });

  ui.startLoop(() => {});

  assert.ok(terminal.writes().includes("\x1b[5 q"));
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
      new TerminalInputDecoder(hooks, {
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

test("raw loop error keeps its semantic notice tone", () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
  });
  ui.startLoop(() => {});

  ui.showError("shutdown failed");
  ui.drainLoop();

  const block = ui.blockFor("notice", "local-1");
  assert.equal(block.kind, "notice");
  assert.equal(block.tone, "error");
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
  const editor = new EditorState();
  editor.apply({ kind: "insert", text: "/e" }, { runtimeActive: false });
  editor.setCompletions(registry.complete(editor.text, { state: "IDLE" }));
  const frame = ui.buildFrame({ width: 80, editor });

  assert.equal(frame.lines.filter((line) => line.includes("/exit")).length, 1);
  assert.ok(frame.lines.some((line) => line.includes("deepseek-v4-flash")));
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
  const editor = new EditorState();
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

  const frame = ui.buildFrame({ width: 18, editor: new EditorState() });

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
  const renderer = new MainScreenRenderer(terminal);
  const editor = new EditorState();
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
  const editor = new EditorState();
  editor.apply(
    { kind: "insert", text: "first line\nsecond line" },
    { runtimeActive: false },
  );
  const frame = ui.buildFrame({ width: 80, editor });

  assert.ok(frame.lines.some((line) => stripTerminalControls(line).includes("> first line")));
  assert.ok(frame.lines.some((line) => stripTerminalControls(line).includes("  second line")));
  assert.equal(
    frame.lines.filter(
      (line) =>
        stripTerminalControls(line).includes("first line") ||
        stripTerminalControls(line).includes("second line"),
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

test("selector receives input before composer and restores focus on submit", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  const selection = ui.select({
    id: "effort",
    title: "Reasoning effort",
    items: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
    currentValue: "low",
  });
  ui.drainLoop();
  ui.feedInputBytes(bytes("\x1b[B\r"));
  ui.drainLoop();

  assert.equal(await selection, "high");
  assert.deepEqual(submitted, []);
  assert.equal(ui.focusedComponentId(), "composer");
});

test("selector cancellation resolves null without submitting composer input", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 8 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 8 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  const selection = ui.select({
    id: "provider",
    title: "Provider",
    items: [{ value: "deepseek", label: "DeepSeek" }],
  });
  ui.drainLoop();
  emulator.write(terminal.writes());
  terminal.clearWrites();
  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();
  emulator.write(terminal.writes());

  assert.equal(await selection, null);
  assert.deepEqual(submitted, []);
  assert.equal(emulator.logicalLines.filter((line) => line.includes("> ")).length, 1);
  assert.ok(emulator.viewportLines.some((line) => line.includes("│>")));
});

test("interactive command component journey preserves scrollback and cursor", async () => {
  const driver = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const terminal = new TerminalEmulator({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ theme: "dark", driver });
  const presenter = new TerminalCommandPresenter(ui);
  const { commands } = createSessionCommandFixture({ presenter });
  ui.setCommandRegistry(commands.registry);
  ui.startLoop((text) => {
    void commands.execute(text);
  });

  async function type(value: string): Promise<void> {
    ui.feedInputBytes(bytes(value));
    ui.drainLoop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    ui.drainLoop();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    ui.drainLoop();
    terminal.write(driver.writes());
    driver.clearWrites();
  }

  await type("/");
  const slashCompletion = terminal.logicalLines.join("\n");
  assert.ok(slashCompletion.includes("/apikey"), slashCompletion);
  await type("h");
  const shrunkCompletion = terminal.viewportLines.join("\n");
  assert.ok(shrunkCompletion.includes("/help"));
  assert.equal(shrunkCompletion.includes("/apikey"), false);
  assert.equal(shrunkCompletion.includes("/cancel"), false);
  await type("\x1b");
  await type("\x03");

  await type("/help\r");
  await type("/providers\r");
  await type("/model\r");
  assert.equal(ui.focusedComponentId(), "model-name");
  await type("\x1b");
  assert.equal(ui.focusedComponentId(), "composer");
  await type("/model\r");
  assert.equal(ui.focusedComponentId(), "model-name");
  await type("\x1b[B\r");
  await type("/effort\r");
  await type("\x1b[B\r");
  await type("中文abc");

  const screen = terminal.logicalLines.join("\n");
  assert.ok(screen.includes("/model [provider|model] [model]"));
  assert.ok(screen.includes("deepseek"));
  assert.equal(screen.includes("Model providers:\n  1."), false);
  assert.equal(/^[ ]+[0-9]+[.)][ ]/mu.test(screen), false);
  assert.equal(/[╭╮╰╯│]/u.test(screen), true);
  assert.equal(screen.split("> 中文abc").length - 1, 1);
  assert.equal(terminal.cursorColumn, visibleWidth("│> 中文abc"));
  assert.ok(terminal.scrollback.length > 0);
});

test("task 9 selection ids route provider and searchable model views", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 12 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});

  const provider = ui.select({
    id: "model-provider",
    title: "Select model provider",
    items: [{ value: "deepseek", label: "DeepSeek" }],
  });
  ui.drainLoop();
  assert.ok(terminal.writes().includes("Select model provider"));
  assert.equal(terminal.writes().includes("Search models"), false);
  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();
  assert.equal(await provider, null);

  terminal.clearWrites();
  const model = ui.select({
    id: "model-name",
    title: "Select model",
    searchable: true,
    items: [{ value: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
  });
  ui.drainLoop();
  assert.ok(terminal.writes().includes("Search models"));
  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();
  assert.equal(await model, null);
});

test("model command uses persistent selectors for submit and cancellation", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 16 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const presenter = new TerminalCommandPresenter(ui);
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const cancelled = commands.execute("/model");
  await drainUntil(ui, () => terminal.writes().includes("Search models"));
  assert.equal(terminal.writes().includes("Select model provider"), false);
  assert.equal(terminal.writes().includes("Select provider: "), false);
  assert.ok(terminal.writes().includes("deepseek-v4-flash"));
  assert.equal(terminal.writes().includes("Select model or search: "), false);
  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();
  await cancelled;
  assert.equal(agent.model, "deepseek-v4-flash");

  const selected = commands.execute("/model");
  await drainUntil(ui, () => ui.focusedComponentId() === "model-name");
  ui.feedInputBytes(bytes("\x1b[B\r"));
  ui.drainLoop();
  await selected;

  assert.equal(agent.model, "deepseek-v4-pro");
});

test("model picker searches all configured providers beyond the visible page", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const { commands, catalog, agent } = createSessionCommandFixture({
    presenter: new TerminalCommandPresenter(ui),
    configured: new Set(["deepseek", "anthropic"]),
  });
  const template = catalog.listModels("anthropic")[0]!;
  catalog.models.set("anthropic", Array.from({ length: 30 }, (_, index) => ({
    ...template,
    id: `model-${String(index).padStart(2, "0")}`,
    name: `Model ${index}`,
  })));

  const selection = commands.execute("/model");
  try {
    await drainUntil(ui, () => ui.focusedComponentId() === "model-name");
    assert.equal(ui.focusedComponentId(), "model-name");
    emulator.write(terminal.writes());
    assert.ok(emulator.viewportLines.some((line) => line.includes("Select model from configured providers")));
    assert.ok(emulator.viewportLines.some((line) => line.includes("Search models")));
    ui.feedInputBytes(bytes("anthropic/model-29\r"));
    ui.drainLoop();
    await selection;

    assert.equal(agent.provider, "anthropic");
    assert.equal(agent.model, "model-29");
    assert.equal(ui.focusedComponentId(), "composer");
    assert.equal(ui.interactiveLoop?.editor.text, "");
  } finally {
    ui.close();
    await selection;
  }
});

test("effort command uses persistent selector submit and cancellation", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 12 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const presenter = new TerminalCommandPresenter(ui);
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const cancelled = commands.execute("/effort");
  await drainUntil(ui, () => terminal.writes().includes("Reasoning effort"));
  assert.ok(terminal.writes().includes("Reasoning effort"));
  assert.equal(terminal.writes().includes("Select effort: "), false);
  assert.equal(terminal.writes().includes("  1. off"), false);
  ui.feedInputBytes(bytes("\x1b"));
  ui.drainLoop();
  await cancelled;
  assert.equal(agent.reasoningEffort, "high");

  const selected = commands.execute("/effort");
  await drainUntil(ui, () => ui.focusedComponentId() === "model-effort");
  ui.feedInputBytes(bytes("\x1b[A\r"));
  ui.drainLoop();
  await selected;

  assert.equal(agent.reasoningEffort, "medium");
});

test("login command routes secret input through the persistent auth dialog", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 12 });
  const emulator = new TerminalEmulator({ columns: 80, rows: 12 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const presenter = new TerminalCommandPresenter(ui);
  const catalog = new FakeCatalog([{
    id: "deepseek",
    name: "DeepSeek",
    authName: "DeepSeek API key",
    dynamicModels: false,
    verified: false,
  }]);
  const providerAuth = new ProviderAuthController({
    auth: {
      status: async () => ({ configured: false }),
      loginApiKey: async (_provider, interaction) => {
        assert.equal(await interaction.prompt({
          type: "secret",
          message: "Enter API key",
        }), "task10-secret");
        return { configured: true, source: "stored credential" };
      },
      logout: async () => {},
    },
  });
  const commands = new SessionCommands({
    agent: new FakeAgent({ model: "deepseek-v4-flash", provider: "deepseek" }),
    selector: new ModelSelector({ catalog, providerAuth }),
    catalog,
    providerAuth,
    currentConfig: {
      model: "deepseek-v4-flash",
      provider: "deepseek",
      baseUrl: null,
    },
    presenter,
  });

  const login = commands.execute("/login deepseek");
  await drainUntil(ui, () => ui.focusedComponentId() === "auth-deepseek");
  emulator.write(terminal.writes());
  terminal.clearWrites();
  assert.equal(ui.focusedComponentId(), "auth-deepseek");
  assert.equal(terminal.writes().includes("  1. deepseek"), false);
  ui.feedInputBytes(bytes("task10-secret"));
  ui.drainLoop();
  const maskedWrites = terminal.writes();
  emulator.write(maskedWrites);
  terminal.clearWrites();
  assert.ok(emulator.viewportLines.join("\n").includes("•••••••••••••"));
  assert.equal(maskedWrites.includes("task10-secret"), false);
  ui.feedInputBytes(bytes("\r"));
  ui.drainLoop();
  await login;
  emulator.write(terminal.writes());

  assert.equal(terminal.writes().includes("task10-secret"), false);
  assert.equal(emulator.logicalLines.join("\n").includes("task10-secret"), false);
  assert.equal(ui.buildHistoryLines(80).join("\n").includes("task10-secret"), false);
  assert.ok(
    stripTerminalControls(ui.buildHistoryLines(80).join("\n")).includes(
      "Logged in to deepseek",
    ),
  );
});

test("runtime component journey freezes reasoning, toggles tools, scrolls, and resizes", () => {
  const driver = new MemoryTerminalDriver({ columns: 40, rows: 6 });
  const terminal = new TerminalEmulator({ columns: 40, rows: 6 });
  const ui = new TerminalUI({ theme: "light", driver });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  function flush(): void {
    ui.drainLoop();
    terminal.write(driver.writes());
    driver.clearWrites();
  }

  flush();
  ui.feedInputBytes(bytes("first turn\r"));
  ui.publishEvent(event("model.reasoning_delta", "r1", { text: "inspect once" }));
  flush();
  ui.publishEvent(event("model.text_delta", "r1", { text: "first answer" }));
  ui.publishEvent(event("model.reasoning_delta", "r1", { text: " late reasoning" }));
  ui.publishEvent(event("tool.started", "tool-1", {
    name: "bash",
    arguments: { command: "printf local" },
  }));
  ui.publishEvent(event("tool.output_delta", "tool-1", {
    stream: "stdout",
    text: "local tool output",
  }));
  ui.publishEvent(event("tool.finished", "tool-1", {
    status: "completed",
    exit_code: 0,
    duration_ms: 2,
  }));
  flush();

  assert.equal(ui.blockFor("thinking", "r1").text, "inspect once");
  assert.equal(ui.buildHistoryLines(40).join("\n").includes("local tool output"), false);
  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(true));
  flush();
  assert.ok(ui.buildHistoryLines(40).join("\n").includes("local tool output"));
  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(false));
  flush();
  assert.equal(ui.buildHistoryLines(40).join("\n").includes("local tool output"), false);

  ui.publishEvent(event("model.response_committed", "r1"));
  ui.feedInputBytes(bytes("second turn\r"));
  ui.publishEvent(event("model.text_delta", "r2", { text: "second answer" }));
  flush();

  assert.deepEqual(submitted, ["first turn", "second turn"]);
  assert.ok(terminal.scrollback.join("\n").includes("first"));
  assert.ok(terminal.logicalLines.join("\n").includes("second answer"));

  driver.resize({ columns: 80, rows: 8 });
  terminal.resize({ columns: 80, rows: 8 });
  ui.applyDisplayAction(makeToggleToolOutputDisplayAction(false));
  flush();

  const resized = terminal.logicalLines.join("\n");
  assert.ok(resized.includes("first answer"));
  assert.ok(resized.includes("second answer"));
  assert.ok(terminal.logicalLines.every((value) => visibleWidth(value) <= 80));
});

function replSession(options: {
  readonly submitAction?: SessionReplSession["submitAction"];
  readonly close?: () => Promise<boolean>;
  readonly runtimeNotices?: string[];
} = {}): SessionReplSession {
  const runtimeNotices = options.runtimeNotices ?? [];
  return {
    state: "idle",
    eventBus: { flush: async () => {} },
    submitInput: async () => {
      throw new Error("submitInput is not used by action routing");
    },
    submitAction: options.submitAction ?? (async () => false),
    promotePendingToSteer: () => 0,
    queueStatus: () => ({}),
    publishNotice: (text) => {
      runtimeNotices.push(text);
    },
    waitForIdle: async () => true,
    close: options.close ?? (async () => true),
  };
}

test("unknown commands use typed info notices with suggestions", async () => {
  const presenter = new RecordingPresenter();
  const runtimeNotices: string[] = [];
  const ui: SessionUiLike = { close: () => {} };

  await runSessionRepl(replSession({ runtimeNotices }), {
    ui,
    presenter,
    suggestCommand: () => "/help",
    commandHandler: async () => ({ status: "not_found", command: "/hep" }),
    runUi: (submit) => {
      submit("/hep");
    },
  });

  assert.deepEqual(presenter.notices, [{
    text: "Unknown command: /hep. Did you mean /help?",
    tone: "info",
  }]);
  assert.deepEqual(runtimeNotices, []);
});

test("rejected messages use typed error notices", async () => {
  const presenter = new RecordingPresenter();
  const runtimeNotices: string[] = [];
  const session = replSession({
    runtimeNotices,
    submitAction: async () => ({
      event: {} as never,
      routed: {} as never,
      taskId: null,
      queued: false,
      control: false,
      rejected: true,
      reason: "policy denied input",
    }),
  });

  await runSessionRepl(session, {
    ui: { close: () => {} },
    presenter,
    suggestCommand: () => null,
    runUi: (submit) => {
      submit("blocked content");
    },
  });

  assert.deepEqual(presenter.notices, [{
    text: "Message rejected: policy denied input",
    tone: "error",
  }]);
  assert.deepEqual(runtimeNotices, []);
});

test("shutdown errors use typed error notices", async () => {
  const presenter = new RecordingPresenter();
  const legacyErrors: string[] = [];

  const clean = await runSessionRepl(replSession({
    close: async () => false,
  }), {
    ui: {
      renderError: null,
      showError: (message) => legacyErrors.push(message),
      close: () => {},
    },
    presenter,
    suggestCommand: () => null,
    runUi: () => {},
  });

  assert.equal(clean, false);
  assert.deepEqual(presenter.notices, [{
    text: "Task worker did not stop before the shutdown timeout.",
    tone: "error",
  }]);
  assert.deepEqual(legacyErrors, []);
});

test("prompt modal takes priority over an active selector", async () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
  });
  ui.startLoop(() => {});

  const selection = ui.select({
    id: "model",
    title: "Model",
    items: [{ value: "v4", label: "v4" }],
  });
  const prompt = ui.prompt({ id: "credential", kind: "text", message: "Credential" });
  ui.drainLoop();
  ui.feedInputBytes(bytes("value\r"));
  ui.drainLoop();

  assert.equal(await prompt, "value");
  assert.equal(ui.focusedComponentId(), "model");
  ui.close();
  assert.equal(await selection, null);
});

test("closing a loop cancels a pending view", async () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
  });
  ui.startLoop(() => {});

  const selection = ui.select({
    id: "effort",
    title: "Reasoning effort",
    items: [{ value: "low", label: "low" }],
  });
  ui.close();

  assert.equal(await selection, null);
});

test("secret prompt values never reach terminal writes", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});

  const secret = "task6-secret-fixture";
  const prompt = ui.prompt({ id: "api-key", kind: "secret", message: "Enter API key" });
  ui.drainLoop();
  ui.feedInputBytes(bytes(`${secret}\r`));
  ui.drainLoop();

  assert.equal(await prompt, secret);
  assert.equal(terminal.writes().includes(secret), false);
});

test("closing a loop disposes a pending secret prompt before resolving null", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});

  const secret = "task6-close-secret";
  const prompt = ui.prompt({ id: "api-key", kind: "secret", message: "Enter API key" });
  ui.drainLoop();
  ui.feedInputBytes(bytes(secret));
  ui.drainLoop();
  ui.close();

  assert.equal(await prompt, null);
  assert.equal(terminal.writes().includes(secret), false);
});

test("raw newline input stays out of the hidden composer while a selector is active", async () => {
  const ui = new TerminalUI({
    driver: new MemoryTerminalDriver({ columns: 80, rows: 24 }),
  });
  ui.startLoop(() => {});

  const selection = ui.select({
    id: "effort",
    title: "Reasoning effort",
    items: [{ value: "low", label: "low" }],
  });
  ui.drainLoop();
  ui.feedInputBytes(bytes("\x1b[13;2u"));
  ui.drainLoop();

  assert.equal(ui.interactiveLoop?.editor.text, "");
  assert.equal(ui.focusedComponentId(), "effort");
  ui.close();
  assert.equal(await selection, null);
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
  assert.ok(lines.some((line) => line.includes("38;2") && line.includes("代码")));
  assert.ok(!lines.some((line) => line.includes("48;2") && line.includes("代码")));
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

test("event sinks hide folded tool output and render status", () => {
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
  assert.ok(!plainRendered.includes("very long output"));
  assert.ok(!terminalRendered.includes("very long output"));
  assert.ok(plainRendered.includes("warning"));
  assert.ok(!terminalRendered.includes("warning"));
  assert.ok(plainRendered.includes("completed"));
  assert.ok(terminalRendered.includes("completed"));
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
  });

  ui.showWelcome();

  const rendered = stream.join("\n");
  assert.ok(rendered.includes("Welcome to LaoHuang Code!"));
  assert.ok(rendered.includes("Send /help for help information."));
  assert.ok(rendered.includes("/tmp/demo"));
  assert.ok(rendered.includes("deepseek/deepseek-v4-pro"));
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

test("run renders command presenter blocks appended while stdin is idle", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const presenter = new TerminalCommandPresenter(ui);
  const { commands } = createSessionCommandFixture({ presenter });
  ui.setCommandRegistry(commands.registry);
  ui.startLoop((text) => {
    void commands.execute(text);
  });
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);
  if (loop === null) {
    return;
  }
  const input = new FakeInputSource();
  const done = loop.run(input);
  try {
    terminal.clearWrites();
    await commands.execute("/help");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(terminal.writes().includes("/model [provider|model] [model]"));
  } finally {
    loop.requestExit();
    await done;
  }
});

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
