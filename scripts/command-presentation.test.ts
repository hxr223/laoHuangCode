import assert from "node:assert/strict";
import test from "node:test";

import { PlainCommandPresenter } from "../apps/cli/src/plain-command-presenter.ts";
import type { PromptPresentation, SelectionPresentation } from "../apps/cli/src/command-presentation.ts";
import { TerminalCommandPresenter } from "../apps/cli/src/terminal-command-presenter.ts";
import { TerminalUI } from "../packages/terminal/tui/src/index.ts";

test("plain presenter formats the same help facts", () => {
  const output: string[] = [];
  const presenter = new PlainCommandPresenter({
    output: (value) => output.push(value),
    input: async () => "",
    secretInput: async () => "",
  });
  presenter.help({ commands: [{ name: "/help", usage: "/help", description: "查看命令帮助" }] });
  assert.deepEqual(output, ["Commands:", "  /help  查看命令帮助"]);
});

test("plain presenter returns secret answers without outputting them", async () => {
  const output: string[] = [];
  const presenter = new PlainCommandPresenter({
    output: (value) => output.push(value),
    input: async () => "visible",
    secretInput: async () => "secret-1",
  });

  assert.equal(await presenter.prompt({
    id: "key",
    kind: "secret",
    message: "Enter key",
  }), "secret-1");
  assert.deepEqual(output, []);
});

test("terminal presenter appends a help transcript block", () => {
  const ui = new TerminalUI();
  const blocks: Array<Parameters<TerminalUI["appendTranscript"]>[0]> = [];
  const append = ui.appendTranscript.bind(ui);
  ui.appendTranscript = (block) => {
    blocks.push(block);
    append(block);
  };
  const presenter = new TerminalCommandPresenter(ui);

  presenter.help({ commands: [{ name: "/help", usage: "/help", description: "show commands" }] });

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.kind, "help");
  assert.deepEqual(blocks[0], {
    kind: "help",
    key: "local-1",
    commands: [{ name: "/help", usage: "/help", description: "show commands" }],
    mutable: false,
  });
});

test("terminal presenter delegates selection requests to TerminalUI", async () => {
  const ui = new TerminalUI();
  let received: SelectionPresentation | null = null;
  ui.select = async (request) => {
    received = request;
    return "deepseek";
  };
  const presenter = new TerminalCommandPresenter(ui);
  const request: SelectionPresentation = {
    id: "provider",
    title: "Select provider",
    items: [{ value: "deepseek", label: "DeepSeek" }],
  };

  assert.equal(await presenter.select(request), "deepseek");
  assert.deepEqual(received, request);
});

test("terminal presenter returns secret prompt values without appending them", async () => {
  const ui = new TerminalUI();
  const blocks: Array<Parameters<TerminalUI["appendTranscript"]>[0]> = [];
  ui.appendTranscript = (block) => {
    blocks.push(block);
  };
  let received: PromptPresentation | null = null;
  ui.prompt = async (request: PromptPresentation | string): Promise<string | null> => {
    received = typeof request === "string"
      ? { id: "legacy", kind: "text", message: request }
      : request;
    return "secret-1";
  };
  const presenter = new TerminalCommandPresenter(ui);

  assert.equal(await presenter.prompt({
    id: "key",
    kind: "secret",
    message: "Enter key",
  }), "secret-1");
  assert.deepEqual(received, { id: "key", kind: "secret", message: "Enter key" });
  assert.deepEqual(blocks, []);
});
