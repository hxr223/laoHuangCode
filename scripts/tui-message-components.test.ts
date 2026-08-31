import { test } from "node:test";
import assert from "node:assert/strict";

import { AssistantMessage } from "../packages/terminal/tui/src/tui/components/messages/assistant-message.ts";
import { NoticeMessage } from "../packages/terminal/tui/src/tui/components/messages/notice-message.ts";
import { ThinkingMessage } from "../packages/terminal/tui/src/tui/components/messages/thinking-message.ts";
import { ToolMessage } from "../packages/terminal/tui/src/tui/components/messages/tool-message.ts";
import { UserMessage } from "../packages/terminal/tui/src/tui/components/messages/user-message.ts";
import { WelcomeMessage } from "../packages/terminal/tui/src/tui/components/messages/welcome-message.ts";
import { renderMarkdownStyledLines } from "../packages/terminal/tui/src/tui/markdown.ts";
import {
  createAssistantBlock,
  createNoticeBlock,
  createThinkingBlock,
  createToolBlock,
  createUserBlock,
  createWelcomeBlock,
} from "../packages/terminal/tui/src/tui/transcript-store.ts";
import { PI_DARK, PI_LIGHT, type TerminalTheme } from "../packages/terminal/tui/src/tui/theme.ts";

type Snapshot = Array<Array<{ text: string; style?: object }>>;

function snapshot(component: { render(context: { width: number; theme: TerminalTheme }): { lines: readonly { spans: readonly { text: string; style?: object }[] }[] } }, width: number, theme: TerminalTheme): Snapshot {
  return component.render({ width, theme }).lines.map((line) =>
    line.spans.map((item) => item.style === undefined
      ? { text: item.text }
      : { text: item.text, style: item.style }),
  );
}

test("assistant and input text keep terminal default foreground", () => {
  const assistant = new AssistantMessage({ text: "answer" });
  const user = new UserMessage({ text: "question" });
  const body = assistant.render({ width: 40, theme: PI_DARK }).lines.flatMap((value) => value.spans);
  const input = user.render({ width: 40, theme: PI_DARK }).lines.flatMap((value) => value.spans);

  assert.ok(body.some((item) => item.text.includes("answer")));
  assert.ok(body.every((item) => item.style?.foreground !== "muted"));
  assert.ok(input.some((item) => item.text.includes("question") && item.style?.foreground === undefined));
  assert.ok(input.some((item) => item.text === "✨ " && item.style?.foreground === "accent"));
  assert.ok(input.every((item) => item.style?.background === undefined));
});

test("thinking is muted italic without styling later answers", () => {
  const thinking = new ThinkingMessage({ text: "inspect" });
  const rendered = thinking.render({ width: 40, theme: PI_DARK });

  assert.ok(rendered.lines.flatMap((value) => value.spans).some((item) =>
    item.style?.foreground === "thinking" && item.style.italic === true
  ));
});

test("notice tone selects semantic style", () => {
  const warning = new NoticeMessage({ text: "blocked", tone: "warning" });
  const spans = warning.render({ width: 40, theme: PI_DARK }).lines[0]!.spans;

  assert.equal(spans[0]!.style?.foreground, "warning");
});

test("message components emit semantic styled-line snapshots at 40 and 80 columns", () => {
  const components = [
    new UserMessage({ text: "question" }),
    new AssistantMessage({ text: "# Answer\n\nplain body" }),
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
    new NoticeMessage({ text: "saved", tone: "success" }),
    new WelcomeMessage({
      title: "Welcome to LaoHuang Code!",
      details: [
        "Send /help for help information.",
        "Directory: /worktree",
        "Session: session_123",
        "Model: deepseek/deepseek-v4-flash",
        "Version: 0.0.0",
      ],
    }),
  ];

  for (const width of [40, 80]) {
    for (const theme of [PI_DARK, PI_LIGHT]) {
      const rendered = components.map((component) => snapshot(component, width, theme));
      assert.deepEqual(rendered, expectedSnapshots(width));
    }
  }
});

function expectedSnapshots(width: number): Snapshot[] {
  return [
    [[
      { text: "✨ ", style: { foreground: "accent" } },
      { text: "question" },
      { text: " ".repeat(width - 11) },
    ]],
    [
      [{ text: "Answer", style: { bold: true, foreground: "heading" } }],
      [],
      [{ text: "plain body", style: {} }],
    ],
    [[
      { text: "thinking  inspect", style: { foreground: "thinking", italic: true } },
      { text: " ".repeat(width - 17) },
    ]],
    [
      [
        { text: "● bash", style: { foreground: "success" } },
        { text: "  $ echo hello", style: { foreground: "bash" } },
        { text: " ".repeat(width - 20) },
      ],
      [
        { text: `completed · exit 0 · 12ms${" ".repeat(width - 25)}` },
      ],
      [
        { text: `hello${" ".repeat(width - 5)}` },
      ],
    ],
    [[
      { text: "saved", style: { foreground: "success" } },
      { text: " ".repeat(width - 5) },
    ]],
    [
      [
        { text: "╭", style: { foreground: "accent" } },
        { text: "─".repeat(width - 2), style: { foreground: "accent" } },
        { text: "╮", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: "H", style: { foreground: "accent", bold: true } },
        { text: "   " },
        { text: "Welcome to LaoHuang Code!", style: { foreground: "accent", bold: true } },
        { text: " ".repeat(width - 31) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: "    " },
        { text: "Send /help for help information.", style: { foreground: "dim" } },
        { text: " ".repeat(width - 38) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: " ".repeat(width - 2) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: "Directory:", style: { bold: true } },
        { text: " /worktree" },
        { text: " ".repeat(width - 22) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: "Session:", style: { bold: true } },
        { text: " session_123" },
        { text: " ".repeat(width - 22) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: "Model:", style: { bold: true } },
        { text: " deepseek/deepseek-v4-flash" },
        { text: " ".repeat(width - 35) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "│", style: { foreground: "accent" } },
        { text: "Version:", style: { bold: true } },
        { text: " 0.0.0" },
        { text: " ".repeat(width - 16) },
        { text: "│", style: { foreground: "accent" } },
      ],
      [
        { text: "╰", style: { foreground: "accent" } },
        { text: "─".repeat(width - 2), style: { foreground: "accent" } },
        { text: "╯", style: { foreground: "accent" } },
      ],
    ],
  ];
}

test("markdown uses semantic spans and leaves ordinary body text uncolored", () => {
  const lines = renderMarkdownStyledLines("# Heading\n\n`code` and [link](https://example.test)", 40);
  const spans = lines.flatMap((line) => line.spans);

  assert.ok(spans.some((item) => item.style?.foreground === "heading"));
  assert.ok(spans.some((item) => item.style?.foreground === "code"));
  assert.ok(spans.every((item) => item.style?.background === undefined));
  assert.ok(spans.some((item) => item.style?.foreground === "link"));
  assert.ok(spans.some((item) => item.text.includes("and") && item.style?.foreground === undefined));
});

test("typed transcript constructors produce every current block variant", () => {
  const blocks = [
    createUserBlock("u1", "question"),
    createAssistantBlock("a1"),
    createThinkingBlock("t1"),
    createToolBlock("tool1", {
      name: "bash",
      subject: "$ pwd",
      status: "running",
      expanded: false,
    }),
    createNoticeBlock("n1", "blocked", "warning"),
    createWelcomeBlock("hello", ["/help for commands"]),
  ];

  assert.deepEqual(blocks.map((block) => block.kind), [
    "user",
    "assistant",
    "thinking",
    "tool",
    "notice",
    "welcome",
  ]);
  assert.equal(blocks[1]!.mutable, true);
  assert.equal(blocks[2]!.mutable, true);
  assert.equal(blocks[3]!.expanded, false);
});

test("expanded tool messages redact command and output secrets", () => {
  const privateValue = "task3-redaction-fixture";
  const rendered = new ToolMessage({
    name: "bash",
    subject: `$ deploy --api-key ${privateValue}`,
    status: "completed",
    exitCode: 0,
    durationMs: 1,
    stdout: `token=${privateValue}`,
    stderr: `Authorization: Bearer ${privateValue}`,
    expanded: true,
  }).render({ width: 80, theme: PI_DARK }).lines.flatMap((line) => line.spans)
    .map((span) => span.text).join("\n");

  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(!rendered.includes(privateValue));
});

test("expanded tool messages redact credential aliases", () => {
  const clientSecret = "task3-client-secret-fixture";
  const privateKey = "task3-private-key-fixture";
  const authorization = "task3-authorization-fixture";
  const rendered = new ToolMessage({
    name: "bash",
    subject: `$ deploy client_secret=${clientSecret}`,
    status: "completed",
    exitCode: 0,
    durationMs: 1,
    stdout: `private_key=${privateKey}`,
    stderr: `authorization=${authorization}`,
    expanded: true,
  }).render({ width: 80, theme: PI_DARK }).lines.flatMap((line) => line.spans)
    .map((span) => span.text).join("\n");

  assert.ok(rendered.includes("[REDACTED]"));
  assert.ok(!rendered.includes(clientSecret));
  assert.ok(!rendered.includes(privateKey));
  assert.ok(!rendered.includes(authorization));
});
