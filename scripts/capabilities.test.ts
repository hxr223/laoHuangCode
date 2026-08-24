import test from "node:test";
import assert from "node:assert/strict";

import { TerminalUI } from "../src/terminal/ui.ts";
import { MemoryTerminalDriver } from "../src/terminal/screen.ts";

test("an unavailable key action shows a notice without submitting model input", () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({
    driver: terminal,
    capabilities: { reasoning: false },
  });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  ui.feedInputBytes(new TextEncoder().encode("draft\x14\r"));
  ui.drainLoop();

  assert.deepEqual(submitted, ["draft"]);
  assert.match(ui.buildHistoryLines(80).join("\n"), /Thinking controls are unavailable/);
});
