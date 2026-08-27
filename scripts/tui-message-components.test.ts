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
    new WelcomeMessage({ title: "hello", details: ["/help for commands"] }),
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
      { text: " ", style: { background: "user_bg" } },
      { text: "question" },
      { text: " ", style: { background: "user_bg" } },
      { text: " ".repeat(width - 10), style: { background: "user_bg" } },
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
        { text: "● bash", style: { foreground: "success", background: "tool_success_bg" } },
        { text: "  $ echo hello", style: { foreground: "bash", background: "tool_success_bg" } },
        { text: " ".repeat(width - 20), style: { background: "tool_success_bg" } },
      ],
      [
        { text: "completed · exit 0 · 12ms", style: { background: "tool_success_bg" } },
        { text: " ".repeat(width - 25), style: { background: "tool_success_bg" } },
      ],
      [
        { text: "hello", style: { background: "tool_success_bg" } },
        { text: " ".repeat(width - 5), style: { background: "tool_success_bg" } },
      ],
    ],
    [[
      { text: "saved", style: { foreground: "success" } },
      { text: " ".repeat(width - 5) },
    ]],
    [
      [
        { text: "hello", style: { foreground: "accent", bold: true } },
        { text: " ".repeat(width - 5) },
      ],
      [
        { text: "/help for commands", style: { foreground: "dim" } },
        { text: " ".repeat(width - 18) },
      ],
    ],
  ];
}

test("markdown uses semantic spans and leaves ordinary body text uncolored", () => {
  const lines = renderMarkdownStyledLines("# Heading\n\n`code` and [link](https://example.test)", 40);
  const spans = lines.flatMap((line) => line.spans);

  assert.ok(spans.some((item) => item.style?.foreground === "heading"));
  assert.ok(spans.some((item) => item.style?.foreground === "code"));
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
