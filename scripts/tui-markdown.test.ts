import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderMarkdownLines,
  renderMarkdownStyledLines,
  visibleWidth,
} from "../packages/terminal/tui/src/tui/markdown.ts";
import { DEFAULT_DARK_THEME, TerminalTheme } from "../packages/terminal/tui/src/tui/theme.ts";

test("plain assistant text uses terminal default foreground", () => {
  const rendered = renderMarkdownLines("plain response", 80, DEFAULT_DARK_THEME).join("\n");

  assert.ok(rendered.includes("plain response"));
  assert.ok(!rendered.includes("\x1b[38;2;212;212;212mplain response"));
});

test("markdown lines fit requested visible width", () => {
  const lines = renderMarkdownLines(
    "**你好** abcdefghijklmnopqrstuvwxyz `代码`",
    12,
    DEFAULT_DARK_THEME,
  );

  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
});

test("markdown code spans use foreground color without terminal background", () => {
  const styled = renderMarkdownStyledLines(
    "`read` and\n\n```bash\nnpm test\n```",
    40,
  ).flatMap((line) => line.spans);
  const rendered = renderMarkdownLines("`read`", 40, DEFAULT_DARK_THEME).join("\n");

  assert.ok(styled.some((item) => item.text.includes("read") && item.style?.foreground === "code"));
  assert.ok(styled.some((item) => item.text.includes("npm test") && item.style?.foreground === "code"));
  assert.ok(styled.every((item) => item.style?.background === undefined));
  assert.ok(!rendered.includes("\x1b[48;2;"));
});

test("markdown truncation preserves the semantic span through the compiler", () => {
  const lines = renderMarkdownLines("**你好abcdef**", 5, DEFAULT_DARK_THEME);

  assert.deepEqual(lines, ["\x1b[1m你好a\x1b[0m"]);
});

test("markdown osc8 controls do not count as visible width", () => {
  const linked = "\x1b]8;;https://example.test\x1b\\abc\x1b]8;;\x1b\\";
  const lines = renderMarkdownLines(linked, 3, DEFAULT_DARK_THEME);

  assert.deepEqual(
    lines.map((line) => visibleWidth(line)),
    [3],
  );
});

test("markdown links render the url in parentheses", () => {
  const lines = renderMarkdownLines(
    "see [the docs](https://example.test/x) now",
    80,
    DEFAULT_DARK_THEME,
  );

  assert.deepEqual(lines, [
    "see \x1b[4;38;2;129;162;190mthe docs\x1b[0m (\x1b[38;2;128;128;128mhttps://example.test/x\x1b[0m) now",
  ]);
});

test("markdown tables render as a semantic grid", () => {
  const lines = renderMarkdownStyledLines(
    "| A | B |\n|---|---|\n| 1 | 2 |",
    40,
  );

  const spans = lines.flatMap((line) => line.spans);
  assert.ok(spans.some((span) => span.style?.foreground === "border_muted"));
  assert.ok(spans.some((span) => span.style?.foreground === "heading" && span.style.bold));
});

test("markdown table semantics compile through the active theme", () => {
  const theme = new TerminalTheme("dark", {
    ...DEFAULT_DARK_THEME.colors,
    heading: "#ff0000",
    border_muted: "#00ff00",
  });
  const lines = renderMarkdownLines("| A |\n|---|\n| 1 |", 40, theme);

  assert.ok(lines.some((line) => line.includes("\x1b[1;38;2;255;0;0mA")));
  assert.ok(
    lines.some((line) => line.includes("\x1b[38;2;0;255;0m ─ ")),
  );
});

test("markdown bullet list continuation lines keep hanging indent", () => {
  const lines = renderMarkdownLines(
    "- first item that is long enough to wrap around the layout width\n- second",
    40,
    DEFAULT_DARK_THEME,
  );

  assert.deepEqual(lines, [
    "",
    "\x1b[38;2;138;190;183m • \x1b[0mfirst item that is long enough to",
    "\x1b[38;2;138;190;183m   \x1b[0mwrap around the layout width",
    "\x1b[38;2;138;190;183m • \x1b[0msecond",
  ]);
});

test("markdown ordered list continuation lines align under item text", () => {
  const lines = renderMarkdownLines(
    "1. first item that is quite long enough to wrap around here\n2. second",
    40,
    DEFAULT_DARK_THEME,
  );

  assert.deepEqual(lines, [
    "",
    "\x1b[38;2;138;190;183m 1 \x1b[0mfirst item that is quite long enough",
    "\x1b[38;2;138;190;183m   \x1b[0mto wrap around here",
    "\x1b[38;2;138;190;183m 2 \x1b[0msecond",
  ]);
});

test("markdown blocks are separated by blank lines", () => {
  const lines = renderMarkdownLines(
    "para one\n\n- item\n\n# Heading\n\npara two",
    40,
    DEFAULT_DARK_THEME,
  );

  assert.deepEqual(lines, [
    "para one",
    "",
    "\x1b[38;2;138;190;183m • \x1b[0mitem",
    "",
    "\x1b[1;38;2;240;198;116mHeading\x1b[0m",
    "",
    "para two",
  ]);
});

test("markdown horizontal rule keeps surrounding blank lines", () => {
  const lines = renderMarkdownLines("before\n\n---\n\nafter", 40, DEFAULT_DARK_THEME);

  assert.deepEqual(lines, [
    "before",
    "",
    `\x1b[38;2;80;80;80m${"─".repeat(40)}\x1b[0m`,
    "",
    "after",
  ]);
});
