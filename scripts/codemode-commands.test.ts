import assert from "node:assert/strict";
import test from "node:test";
import type { CodeMode } from "@laohuang/tools";
import { CommandRegistry } from "../apps/cli/src/commands.ts";
import { createCodeModeCommand } from "../apps/cli/src/codemode-commands.ts";

test("Code Mode commands keep the current session mode separate from the new-session default", async () => {
  let mode: CodeMode = "off";
  let defaultMode: CodeMode = "on";
  const notices: string[] = [];
  const registry = new CommandRegistry([createCodeModeCommand({ getMode: () => mode, setMode: value => { mode = value; },
    getDefaultMode: () => defaultMode, setDefaultMode: value => { defaultMode = value; }, notice: text => notices.push(text) })]);
  assert.equal((await registry.execute("/codemode only", { state: "RUNNING_MODEL" })).status, "handled");
  assert.equal(mode, "only");
  assert.equal(defaultMode, "on");
  assert.equal((await registry.execute("/codemode default off")).status, "handled");
  assert.equal(mode, "only");
  assert.equal(defaultMode, "off");
  await registry.execute("/codemode");
  assert.match(notices.at(-1) ?? "", /only.*off/);
  assert.equal((await registry.execute("/codemode invalid")).status, "error");
  assert.deepEqual(registry.complete("/codemode default ", { state: "IDLE" }).map(item => item.value), ["off", "on", "only"]);
});
