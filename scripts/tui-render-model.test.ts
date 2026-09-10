import assert from "node:assert/strict";
import test from "node:test";

import {
  compileStyledLine,
  compileStyledLines,
} from "../packages/terminal/tui/src/tui/ansi-renderer.ts";
import {
  line,
  lineText,
  span,
  wrapStyledSpans,
} from "../packages/terminal/tui/src/tui/render-model.ts";
import { DEFAULT_DARK_THEME } from "../packages/terminal/tui/src/tui/theme.ts";

test("default foreground stays unstyled", () => {
  const rendered = compileStyledLine(line(span("plain")), 20, DEFAULT_DARK_THEME);
  assert.equal(rendered, "plain");
});

test("semantic spans compile at the ANSI boundary", () => {
  const source = line(
    span("selected", { foreground: "accent", bold: true }),
    span(" description", { foreground: "muted" }),
  );
  const rendered = compileStyledLine(source, 40, DEFAULT_DARK_THEME);
  assert.equal(lineText(source), "selected description");
  assert.match(rendered, /\x1b\[/u);
  assert.equal(rendered.replace(/\x1b\[[0-9;]*m/gu, ""), "selected description");
});

test("compiler rejects a line wider than terminal cells", () => {
  assert.throws(
    () => compileStyledLines([line(span("中文ab"))], 5, DEFAULT_DARK_THEME),
    /rendered line exceeds terminal width/u,
  );
});

test("wrapping treats CRLF as one line break", () => {
  const wrapped = wrapStyledSpans([span("a\r\nb")], 4);
  assert.deepEqual(wrapped.map(lineText), ["a", "b"]);
});

test("wrapping uses a single-cell replacement when a grapheme cannot fit", () => {
  assert.deepEqual(wrapStyledSpans([span("中")], 1).map(lineText), ["�"]);
});
