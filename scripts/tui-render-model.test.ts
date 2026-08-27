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
} from "../packages/terminal/tui/src/tui/render-model.ts";
import { PI_DARK } from "../packages/terminal/tui/src/tui/theme.ts";

test("default foreground stays unstyled", () => {
  const rendered = compileStyledLine(line(span("plain")), 20, PI_DARK);
  assert.equal(rendered, "plain");
});

test("semantic spans compile at the ANSI boundary", () => {
  const source = line(
    span("selected", { foreground: "accent", bold: true }),
    span(" description", { foreground: "muted" }),
  );
  const rendered = compileStyledLine(source, 40, PI_DARK);
  assert.equal(lineText(source), "selected description");
  assert.match(rendered, /\x1b\[/u);
  assert.equal(rendered.replace(/\x1b\[[0-9;]*m/gu, ""), "selected description");
});

test("compiler rejects a line wider than terminal cells", () => {
  assert.throws(
    () => compileStyledLines([line(span("中文ab"))], 5, PI_DARK),
    /rendered line exceeds terminal width/u,
  );
});
