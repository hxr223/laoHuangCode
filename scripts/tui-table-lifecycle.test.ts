import assert from "node:assert/strict";
import test from "node:test";

import { TerminalUI } from "../packages/terminal/tui/src/tui/ui.ts";
import { MemoryTerminalDriver } from "../packages/terminal/tui/src/tui/screen.ts";
import { renderMarkdownStyledLines } from "../packages/terminal/tui/src/tui/markdown.ts";
import { lineText } from "../packages/terminal/tui/src/tui/render-model.ts";

const table = [
  "| | AGENTS.md | CLAUDE.md |",
  "|---|---|---|",
  "| 定位 | 纯编码规则清单 | 概览 + 命令 + 架构 + 规则 |",
  "| 独有内容 | 通用规范（rg、ASCII、不回退改动）、API 形状细节、测试校验、UX 美学 | 项目简介、构建/测试命令、monorepo 结构、路径别名 |",
].join("\n");

test("streaming comparison table and terminal resize keep the input loop usable", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 120, rows: 30 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: string[] = [];
  ui.startLoop((text) => { submitted.push(text); });
  const loop = ui.interactiveLoop!;
  let ended = false;
  const done = loop.run().then(() => { ended = true; });
  try {
    ui.publishEvent({ kind: "task.started", correlation_id: "task-table", payload: {} });
    for (const text of table) {
      ui.publishEvent({ kind: "model.text_delta", correlation_id: "response-table", payload: { text } });
      ui.drainLoop();
      assert.equal(ui.renderError, null);
    }
    ui.publishEvent({ kind: "model.response_committed", correlation_id: "response-table", payload: {} });
    ui.publishEvent({ kind: "task.completed", correlation_id: "task-table", payload: {} });
    ui.drainLoop();

    for (const columns of [80, 40, 12, 120]) {
      terminal.resize({ columns, rows: 30 });
      ui.drainLoop();
      assert.equal(ui.renderError, null, `width ${columns}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ended, false);
    assert.equal(loop.closed, false);
    assert.match(terminal.writes(), /monorepo/);

    ui.feedInputBytes(new TextEncoder().encode("next question\r"));
    ui.drainLoop();
    assert.deepEqual(submitted, ["next question"]);
    assert.equal(ui.renderError, null);
  } finally {
    ui.requestExit();
    await done;
  }
  assert.equal(terminal.restored, true);
});

test("comparison table preserves all cell characters across terminal widths", () => {
  for (const width of [40, 80, 106, 118, 120, 160]) {
    const text = renderMarkdownStyledLines(table, width).map(lineText).join("");
    assert.deepEqual(
      [...text.replace(/[─\s]/gu, "")].sort(),
      [...table.replace(/[|\s-]/gu, "")].sort(),
      `width ${width}`,
    );
  }
});
