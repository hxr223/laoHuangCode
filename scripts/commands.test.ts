import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test files import ".ts" paths directly: Node 22 type stripping cannot
// resolve ".js" specifiers to ".ts" sources (tsc only covers src/).
import {
  CommandRegistry,
  SessionCommands,
  type AgentLike,
  type SessionLike,
} from "../apps/cli/src/commands.ts";
import { createClient } from "@laohuang/llm-openai-compatible";
import { CredentialStore } from "@laohuang/local-config";
import {
  ModelSelector,
  type ProviderRegistry,
} from "../apps/cli/src/model-selection.ts";
import { getProvider, providerNames } from "@laohuang/llm-openai-compatible";
import type { ModelAdapter, ModelRequest, StreamResult } from "@laohuang/llm";

/** Registry wired exactly as production code would wire providers.ts. */
const registry: ProviderRegistry = { get: getProvider, names: providerNames };

interface TestModelAdapter extends ModelAdapter {
  readonly client: unknown;
}

function makeModelAdapter(provider: string, client: unknown): TestModelAdapter {
  return {
    name: provider,
    capabilities: {
      streaming: true,
      reasoningReplay: provider === "deepseek",
      thinkingSettings: provider === "deepseek",
    },
    client,
    runAttempt(_request: ModelRequest): Promise<StreamResult> {
      throw new Error("not used");
    },
  };
}

function fail(reason: string): (prompt: string) => Promise<string> {
  return async () => {
    throw new Error(reason);
  };
}

/** Minimal in-memory CodingAgent stand-in (agent.ts is owned elsewhere). */
class FakeAgent implements AgentLike {
  modelAdapter: ModelAdapter;
  model: string;
  provider: string;
  messages: unknown[] = [{ role: "system", content: "system prompt" }];

  constructor(options: {
    modelAdapter?: ModelAdapter;
    model: string;
    provider?: string;
  }) {
    this.modelAdapter = options.modelAdapter ?? makeModelAdapter("deepseek", {});
    this.model = options.model;
    this.provider = options.provider ?? "deepseek";
  }

  switchModel(options: {
    modelAdapter: ModelAdapter;
    model: string;
    provider: string;
  }): void {
    this.modelAdapter = options.modelAdapter;
    this.model = options.model;
    this.provider = options.provider;
  }

  clearHistory(): void {
    this.messages.splice(1);
  }
}

interface CommandFixture {
  readonly commands: SessionCommands;
  readonly credentials: CredentialStore;
  readonly agent: FakeAgent;
  readonly cleanup: () => void;
}

function makeCommands(
  outputs: string[],
  options: {
    session?: SessionLike | null;
    secretInput?: (prompt: string) => Promise<string>;
    clientFactory?: () => unknown;
    agent?: FakeAgent;
  } = {},
): CommandFixture {
  const root = mkdtempSync(join(tmpdir(), "laohuang-commands-"));
  const credentials = new CredentialStore(join(root, "credentials.json"));
  const agent =
    options.agent ??
    new FakeAgent({ model: "deepseek-v4-flash", provider: "deepseek" });
  const selector = new ModelSelector({
    credentials,
    registry,
    createClient,
    createModelAdapter: makeModelAdapter,
    input: fail("no selection expected"),
    secretInput: fail("no secret expected"),
    output: (message) => {
      outputs.push(message);
    },
    clientFactory: options.clientFactory,
  });
  const commands = new SessionCommands({
    agent,
    selector,
    credentials,
    currentConfig: {
      apiKey: "hidden",
      model: "deepseek-v4-flash",
      baseUrl: null,
      provider: "deepseek",
    },
    input: fail("no provider menu expected"),
    secretInput: options.secretInput ?? (async () => "unused"),
    output: (message) => {
      outputs.push(message);
    },
    session: options.session ?? null,
  });
  return {
    commands,
    credentials,
    agent,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("registry completion has a replacement start and respects state", () => {
  const registry = new CommandRegistry([
    { name: "/exit", description: "退出", usage: "/exit" },
    {
      name: "/login",
      description: "登录",
      usage: "/login",
      allowedStates: new Set(["IDLE"]),
    },
    {
      name: "/model",
      description: "模型",
      usage: "/model [provider]",
      allowedStates: new Set(["IDLE"]),
      argumentCompleter: () => [["current", "当前模型"]],
    },
  ]);

  assert.deepEqual(registry.complete("/lo", { state: "RUNNING_MODEL" }), []);
  assert.equal(
    registry.complete("/mo", { state: "RUNNING_MODEL" })[0]?.value,
    "/model",
  );
  assert.equal(
    registry.complete("/model ", { state: "RUNNING_MODEL" })[0]?.value,
    "current",
  );
  assert.equal(registry.complete("/ex", { state: "IDLE" })[0]?.start, -3);
});

test("slash commands and model arguments are completed", () => {
  const fixture = makeCommands([]);

  const commandsFound = fixture.commands.registry.complete("/mo", {
    state: "IDLE",
  });
  const modelsFound = fixture.commands.registry.complete("/model deepseek ", {
    state: "IDLE",
  });
  const plainFound = fixture.commands.registry.complete("please read files", {
    state: "IDLE",
  });

  assert.ok(commandsFound.some((item) => item.value === "/model"));
  assert.ok(modelsFound.some((item) => item.value === "deepseek-v4-flash"));
  assert.deepEqual(plainFound, []);
  fixture.cleanup();
});

test("running completion filters mutating commands", () => {
  const fixture = makeCommands([]);

  const commandsFound = fixture.commands.registry.complete("/", {
    state: "RUNNING_MODEL",
  });
  const modelArguments = fixture.commands.registry.complete("/model ", {
    state: "RUNNING_MODEL",
  });

  const names = commandsFound.map((item) => item.value);
  assert.ok(!names.includes("/login"));
  assert.ok(names.includes("/cancel"));
  assert.ok(names.includes("/model"));
  assert.deepEqual(
    modelArguments.map((item) => item.value),
    ["current"],
  );
  fixture.cleanup();
});

test("queue commands delegate to the agent session", async () => {
  const session: SessionLike = {
    queueStatus: () => ({
      pending: 2,
      held: 1,
      pendingTokens: 20,
      heldTokens: 10,
      deadLetters: 1,
    }),
    clearQueues: () => 3,
    resumeHeld: () => 1,
    cancelActiveTask: () => false,
    submitAction: () => false,
  };
  const outputs: string[] = [];
  const fixture = makeCommands(outputs, { session });

  await fixture.commands.execute("/queue");
  await fixture.commands.execute("/queue resume");
  await fixture.commands.execute("/queue clear");

  assert.deepEqual(outputs, [
    "Pending: 2 (20 est. tokens) · Held: 1 (10 est. tokens) · Dead letters: 1",
    "Resumed 1 held message(s).",
    "Cleared 3 queued message(s).",
  ]);
  fixture.cleanup();
});

test("/model current reports the active provider and model", async () => {
  const outputs: string[] = [];
  const fixture = makeCommands(outputs);

  const handled = await fixture.commands.execute("/model current");

  assert.equal(handled.status, "handled");
  assert.deepEqual(outputs, ["Current model: deepseek / deepseek-v4-flash"]);
  fixture.cleanup();
});

test("/model switches provider and model without chatting", async () => {
  const outputs: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "laohuang-commands-"));
  const credentials = new CredentialStore(join(root, "credentials.json"));
  credentials.set("deepseek", "saved-key");
  const replacementClient = {};
  const agent = new FakeAgent({ model: "old-model" });
  const selector = new ModelSelector({
    credentials,
    registry,
    createClient,
    createModelAdapter: makeModelAdapter,
    input: fail("no choice should be needed"),
    secretInput: fail("key is already saved"),
    output: () => {},
    clientFactory: () => replacementClient,
  });
  const commands = new SessionCommands({
    agent,
    selector,
    credentials,
    currentConfig: {
      apiKey: "old-key",
      model: "old-model",
      baseUrl: null,
      provider: "openai",
    },
    input: fail("no provider menu expected"),
    secretInput: async () => "unused",
    output: (message) => {
      outputs.push(message);
    },
  });

  // The Python original drove this through run_repl with an /exit follow-up;
  // cli.ts is owned by another workstream, so dispatch directly here.
  const handled = await commands.execute("/model deepseek deepseek-v4-pro");

  assert.equal(handled.status, "handled");
  assert.equal(agent.model, "deepseek-v4-pro");
  assert.equal(
    (agent.modelAdapter as TestModelAdapter).client,
    replacementClient,
  );
  assert.ok(outputs.some((line) => line.includes("deepseek-v4-pro")));
  rmSync(root, { recursive: true, force: true });
});

test("/login and /logout manage saved credentials", async () => {
  const outputs: string[] = [];
  const replacementClient = {};
  const fixture = makeCommands(outputs, {
    secretInput: async () => "new-key",
    clientFactory: () => replacementClient,
  });

  await fixture.commands.execute("/login deepseek");
  await fixture.commands.execute("/apikey");
  await fixture.commands.execute("/logout deepseek");

  assert.equal(
    (fixture.agent.modelAdapter as TestModelAdapter).client,
    replacementClient,
  );
  assert.equal(fixture.credentials.get("deepseek"), null);
  assert.ok(outputs.some((line) => line === "deepseek: configured"));
  assert.ok(!outputs.some((line) => line.includes("new-key")));
  fixture.cleanup();
});

test("/apikey commands remain compatible aliases", async () => {
  const outputs: string[] = [];
  const fixture = makeCommands(outputs, {
    secretInput: async () => "alias-key",
    clientFactory: () => ({}),
  });

  await fixture.commands.execute("/apikey set deepseek");
  assert.equal(fixture.credentials.get("deepseek"), "alias-key");

  await fixture.commands.execute("/apikey remove deepseek");
  assert.equal(fixture.credentials.get("deepseek"), null);
  fixture.cleanup();
});

test("/model does not prompt for missing credentials", async () => {
  const outputs: string[] = [];
  const fixture = makeCommands(outputs, {
    secretInput: fail("/model must not log in"),
  });

  await fixture.commands.execute("/model openai gpt-test");

  assert.ok(outputs.some((line) => line.includes("/login openai")));
  fixture.cleanup();
});

test("/login awaits the injected async secret prompt", async () => {
  const outputs: string[] = [];
  const prompts: string[] = [];
  const fixture = makeCommands(outputs, {
    // TerminalUI.promptSecret resolves only once the interactive loop
    // processes the answer; /login must await it instead of treating the
    // pending promise as the key.
    secretInput: async (prompt) => {
      prompts.push(prompt);
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      return "async-key";
    },
    clientFactory: () => ({}),
  });

  await fixture.commands.execute("/login deepseek");

  assert.deepEqual(prompts, ["Enter deepseek API key: "]);
  assert.equal(fixture.credentials.get("deepseek"), "async-key");
  assert.ok(!outputs.join("\n").includes("async-key"));
  fixture.cleanup();
});
