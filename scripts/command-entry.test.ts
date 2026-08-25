import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandRegistry,
  SessionCommands,
  type AgentLike,
  type SessionLike,
} from "../src/commands.ts";
import { CredentialStore } from "../src/credentials.ts";
import { ModelSelector, type ProviderRegistry } from "../src/model-selection.ts";
import { createClient } from "@laohuang/llm-openai-compatible";
import { getProvider, providerNames } from "@laohuang/llm-openai-compatible";
import { TerminalUI } from "../src/tui/ui.ts";

const providers: ProviderRegistry = { get: getProvider, names: providerNames };

class FakeAgent implements AgentLike {
  messages: unknown[] = [{ role: "system", content: "system prompt" }];

  switchModel(): void {}

  clearHistory(): void {
    this.messages.splice(1);
  }
}

function makeCommands(options: { session?: SessionLike | null } = {}): {
  commands: SessionCommands;
  outputs: string[];
} {
  const outputs: string[] = [];
  const credentials = new CredentialStore("/tmp/laohuang-command-entry-test.json");
  const commands = new SessionCommands({
    agent: new FakeAgent(),
    selector: new ModelSelector({
      credentials,
      registry: providers,
      createClient,
      input: async () => "",
      secretInput: async () => "",
      output: () => {},
    }),
    credentials,
    currentConfig: {
      apiKey: "test-key",
      baseUrl: null,
      model: "deepseek-v4-flash",
      provider: "deepseek",
    },
    input: async () => "",
    secretInput: async () => "",
    output: (message) => {
      outputs.push(message);
    },
    session: options.session ?? null,
  });
  return { commands, outputs };
}

test("typed cancel submits a neutral cancellation action", async () => {
  const actions: unknown[] = [];
  const { commands, outputs } = makeCommands({
    session: {
      activeTask: { state: "RUNNING_MODEL" },
      submitAction: (action) => {
        actions.push(action);
        return true;
      },
      clearQueues: () => 0,
      resumeHeld: () => 0,
      queueStatus: () => ({}),
    },
  });

  const result = await commands.execute("/cancel");

  assert.equal(result.status, "handled");
  assert.deepEqual(actions.map((action) => ({
    type: (action as { type: string }).type,
    source: (action as { source: string }).source,
  })), [{ type: "cancel", source: "command" }]);
  assert.deepEqual(outputs, ["Cancelling current task…"]);
});

test("keyboard cancellation reaches the neutral cancellation action", async () => {
  const actions: unknown[] = [];
  const { commands, outputs } = makeCommands({
    session: {
      activeTask: { state: "RUNNING_MODEL" },
      submitAction: (action) => {
        actions.push(action);
        return true;
      },
      clearQueues: () => 0,
      resumeHeld: () => 0,
      queueStatus: () => ({}),
    },
  });
  const ui = new TerminalUI();
  let submitted: Promise<unknown> | null = null;
  ui.setCancelCallback(() => {
    submitted = commands.execute("/cancel");
  });

  ui.cancelFromKeybinding();
  await submitted;

  assert.deepEqual(actions.map((action) => (action as { type: string }).type), [
    "cancel",
  ]);
  assert.deepEqual(outputs, ["Cancelling current task…"]);
});

test("command entry reports exit requests", async () => {
  const { commands } = makeCommands();

  const result = await commands.execute("/exit");

  assert.equal(result.status, "exit_requested");
});

test("command entry rejects unexpected exit arguments", async () => {
  const { commands } = makeCommands();

  const result = await commands.execute("/exit unexpected");

  assert.equal(result.status, "error");
  assert.equal(result.error instanceof Error ? result.error.message : "", "Usage: /exit");
});

test("command entry reports unknown commands without handling them", async () => {
  const { commands } = makeCommands();

  const result = await commands.execute("/hep");

  assert.deepEqual(result, { status: "not_found", command: "/hep" });
});

test("command entry blocks clear while a task runs", async () => {
  const { commands, outputs } = makeCommands({
    session: {
      activeTask: { state: "RUNNING_MODEL" },
      cancelActiveTask: () => false,
      submitAction: () => false,
      clearQueues: () => 0,
      resumeHeld: () => 0,
      queueStatus: () => ({}),
    },
  });

  const result = await commands.execute("/clear");

  assert.deepEqual(result, { status: "blocked", command: "/clear" });
  assert.deepEqual(outputs, ["/clear is unavailable while the task is running_model."]);
});

test("command entry permits model current while a task runs", async () => {
  const { commands, outputs } = makeCommands({
    session: {
      activeTask: { state: "RUNNING_MODEL" },
      cancelActiveTask: () => false,
      submitAction: () => false,
      clearQueues: () => 0,
      resumeHeld: () => 0,
      queueStatus: () => ({}),
    },
  });

  const result = await commands.execute("/model current");

  assert.equal(result.status, "handled");
  assert.deepEqual(outputs, ["Current model: deepseek / deepseek-v4-flash"]);
});

test("command entry returns an error result for malformed quotes", async () => {
  const { commands } = makeCommands();

  const result = await commands.execute('/help "');

  assert.equal(result.status, "error");
  assert.equal(result.error instanceof Error ? result.error.message : "", "No closing quotation");
});

test("registry returns an error result when a handler throws", async () => {
  const registry = new CommandRegistry([
    {
      name: "/broken",
      description: "broken",
      usage: "/broken",
      handler: () => {
        throw new Error("broken handler");
      },
    },
  ]);

  const result = await registry.execute("/broken");

  assert.equal(result.status, "error");
  assert.equal(result.error instanceof Error ? result.error.message : "", "broken handler");
});
