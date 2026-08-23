import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionCommands,
  type AgentLike,
  type SessionLike,
} from "../src/commands.ts";
import { CredentialStore } from "../src/credentials.ts";
import { ModelSelector, type ProviderRegistry } from "../src/model-selection.ts";
import { createClient } from "../src/client.ts";
import { getProvider, providerNames } from "../src/providers.ts";

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

test("command entry cancels through the session command API", async () => {
  let cancelled = 0;
  const { commands, outputs } = makeCommands({
    session: {
      activeTask: { state: "RUNNING_MODEL" },
      cancelActiveTask: () => {
        cancelled += 1;
        return true;
      },
      clearQueues: () => 0,
      resumeHeld: () => 0,
      queueStatus: () => ({}),
    },
  });

  const result = await commands.execute("/cancel");

  assert.equal(result.status, "handled");
  assert.equal(cancelled, 1);
  assert.deepEqual(outputs, ["Cancelling current task…"]);
});

test("command entry reports exit requests", async () => {
  const { commands } = makeCommands();

  const result = await commands.execute("/exit");

  assert.equal(result.status, "exit_requested");
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
      clearQueues: () => 0,
      resumeHeld: () => 0,
      queueStatus: () => ({}),
    },
  });

  const result = await commands.execute("/model current");

  assert.equal(result.status, "handled");
  assert.deepEqual(outputs, ["Current model: deepseek / deepseek-v4-flash"]);
});
