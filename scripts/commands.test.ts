import test from "node:test";
import assert from "node:assert/strict";

import type {
  ModelAuthStatus,
  ModelCatalog,
  ModelInfo,
  ModelProviderInfo,
  ReasoningEffort,
} from "@laohuang/llm";
import {
  CommandRegistry,
  SessionCommands,
  type AgentLike,
  type SessionLike,
} from "../apps/cli/src/commands.ts";
import { ModelSelector } from "../apps/cli/src/model-selection.ts";
import type { ProviderAuthController } from "../apps/cli/src/provider-auth.ts";
import type { CommandPresenter } from "../apps/cli/src/command-presentation.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

function model(
  provider: string,
  id: string,
  options: {
    reasoning?: boolean;
    supportedReasoningEfforts?: readonly ReasoningEffort[];
  } = {},
): ModelInfo {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    reasoning: options.reasoning ?? false,
    supportedReasoningEfforts: options.supportedReasoningEfforts ?? ["off"],
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

function providerInfo(
  id: string,
  options: { verified: boolean },
): ModelProviderInfo {
  return {
    id,
    name: id,
    authName: `${id} API key`,
    dynamicModels: false,
    verified: options.verified,
  };
}

class FakeCatalog implements ModelCatalog {
  providers: readonly ModelProviderInfo[];
  models = new Map<string, readonly ModelInfo[]>();

  constructor(providers: readonly ModelProviderInfo[]) {
    this.providers = providers;
    this.models.set("anthropic", [model("anthropic", "claude-sonnet-4-5")]);
    this.models.set("deepseek", [
      model("deepseek", "deepseek-v4-flash", {
        reasoning: true,
        supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high"],
      }),
      model("deepseek", "deepseek-v4-pro", {
        reasoning: true,
        supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
      }),
    ]);
  }

  listProviders(): readonly ModelProviderInfo[] {
    return this.providers;
  }

  getProvider(provider: string): ModelProviderInfo | undefined {
    return this.providers.find((item) => item.id === provider);
  }

  listModels(provider: string): readonly ModelInfo[] {
    return this.models.get(provider) ?? [];
  }

  async listAvailableModels(provider: string): Promise<readonly ModelInfo[]> {
    return this.listModels(provider);
  }

  getModel(provider: string, id: string): ModelInfo | undefined {
    return this.listModels(provider).find((item) => item.id === id);
  }

  async refresh(): Promise<void> {}
}

class FakeAuth
  implements
    Pick<
      ProviderAuthController,
      "status" | "login" | "logout" | "ensureConfigured"
    >
{
  readonly loginCalls: string[] = [];
  readonly logoutCalls: string[] = [];
  configured: Set<string>;
  ambientSources: ReadonlyMap<string, string>;

  constructor(
    configured: Set<string>,
    ambientSources: ReadonlyMap<string, string> = new Map(),
  ) {
    this.configured = configured;
    this.ambientSources = ambientSources;
  }

  async status(provider: string): Promise<ModelAuthStatus> {
    const ambientSource = this.ambientSources.get(provider);
    if (ambientSource !== undefined) {
      return { configured: true, source: ambientSource };
    }
    return this.configured.has(provider)
      ? { configured: true, source: "stored credential" }
      : { configured: false };
  }

  async ensureConfigured(
    provider: string,
    options: { promptIfMissing: boolean },
  ): Promise<boolean> {
    if (this.configured.has(provider)) {
      return true;
    }
    if (!options.promptIfMissing) {
      return false;
    }
    return this.login(provider);
  }

  async login(provider: string): Promise<boolean> {
    this.loginCalls.push(provider);
    this.configured.add(provider);
    return true;
  }

  async logout(provider: string): Promise<void> {
    this.logoutCalls.push(provider);
    this.configured.delete(provider);
  }
}

class FakeAgent implements AgentLike {
  model: string;
  provider: string;
  baseUrl: string | null;
  messages: unknown[] = [{ role: "system", content: "system prompt" }];
  readonly modelSwitches: Array<{ provider: string; model: string }> = [];
  reasoningEffort: ReasoningEffort = "high";

  constructor(options: { model: string; provider?: string; baseUrl?: string | null }) {
    this.model = options.model;
    this.provider = options.provider ?? "deepseek";
    this.baseUrl = options.baseUrl ?? null;
  }

  switchModel(options: {
    model: string;
    provider: string;
    baseUrl: string | null;
  }): void {
    this.model = options.model;
    this.provider = options.provider;
    this.baseUrl = options.baseUrl;
    this.modelSwitches.push({
      provider: options.provider,
      model: options.model,
    });
  }

  clearHistory(): void {
    this.messages.splice(1);
  }

  setReasoningEffort(effort: ReasoningEffort): void {
    this.reasoningEffort = effort;
  }

  getReasoningEffort(): ReasoningEffort {
    return this.reasoningEffort;
  }
}

interface CommandFixture {
  readonly commands: SessionCommands;
  readonly auth: FakeAuth;
  readonly agent: FakeAgent;
  readonly outputs: string[];
}

function makeCommands(options: {
  providers?: readonly ModelProviderInfo[];
  configured?: Set<string>;
  ambientSources?: ReadonlyMap<string, string>;
  output?: (message: string) => void;
  input?: (prompt: string) => Promise<string>;
  session?: SessionLike | null;
  agent?: FakeAgent;
  presenter?: CommandPresenter;
} = {}): CommandFixture {
  const outputs: string[] = [];
  const catalog = new FakeCatalog(
    options.providers ?? [
      providerInfo("deepseek", { verified: false }),
      providerInfo("anthropic", { verified: false }),
    ],
  );
  const auth = new FakeAuth(
    options.configured ?? new Set(["deepseek"]),
    options.ambientSources,
  );
  const selector = new ModelSelector({
    catalog,
    providerAuth: auth,
    input: options.input ?? (async () => "deepseek"),
    output: options.output ?? ((message) => outputs.push(message)),
  });
  const agent =
    options.agent ??
    new FakeAgent({ model: "deepseek-v4-flash", provider: "deepseek" });
  const commands = new SessionCommands({
    agent,
    selector,
    catalog,
    providerAuth: auth,
    currentConfig: {
      model: "deepseek-v4-flash",
      baseUrl: null,
      provider: "deepseek",
    },
    input: options.input ?? (async () => "1"),
    output: options.output ?? ((message) => outputs.push(message)),
    presenter: options.presenter,
    session: options.session ?? null,
  });
  return { commands, auth, agent, outputs };
}

test("session commands retain their command presentation port", () => {
  const presenter = new RecordingPresenter();
  const { commands } = makeCommands({ presenter });

  assert.equal(commands.presenter, presenter);
});

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
  const { commands } = makeCommands();

  const commandsFound = commands.registry.complete("/mo", { state: "IDLE" });
  const providerItems = commands.registry.complete("/model ", {
    state: "IDLE",
  });
  const modelItems = commands.registry.complete("/model anthropic ", {
    state: "IDLE",
  });
  const effortItems = commands.registry.complete("/effort ", {
    state: "RUNNING_MODEL",
  });
  const plainFound = commands.registry.complete("please read files", {
    state: "IDLE",
  });

  assert.ok(commandsFound.some((item) => item.value === "/model"));
  assert.ok(providerItems.some((item) => item.value === "anthropic"));
  assert.ok(providerItems.some((item) => item.value === "deepseek-v4-pro"));
  assert.ok(modelItems.some((item) => item.value === "claude-sonnet-4-5"));
  assert.ok(effortItems.some((item) => item.value === "low"));
  assert.ok(effortItems.some((item) => item.value === "current"));
  assert.deepEqual(plainFound, []);
});

test("running completion filters mutating commands", () => {
  const { commands } = makeCommands();

  const commandsFound = commands.registry.complete("/", {
    state: "RUNNING_MODEL",
  });
  const modelArguments = commands.registry.complete("/model ", {
    state: "RUNNING_MODEL",
  });

  const names = commandsFound.map((item) => item.value);
  assert.ok(!names.includes("/login"));
  assert.ok(names.includes("/cancel"));
  assert.ok(names.includes("/effort"));
  assert.ok(names.includes("/model"));
  assert.deepEqual(
    modelArguments.map((item) => item.value),
    ["current"],
  );
});

test("providers command reports available configured and verified independently", async () => {
  const outputs: string[] = [];
  const { commands } = makeCommands({
    providers: [
      providerInfo("anthropic", { verified: false }),
      providerInfo("deepseek", { verified: true }),
    ],
    configured: new Set(["anthropic"]),
    output: (message) => outputs.push(message),
  });

  const result = await commands.execute("/providers");

  assert.equal(result.status, "handled");
  assert.deepEqual(outputs, [
    "anthropic: available, configured, unverified",
    "deepseek: available, not configured, verified",
  ]);

  await commands.execute("/providers anthropic");
  assert.ok(outputs.some((line) => line.includes("Authentication: configured")));
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
  const { commands } = makeCommands({
    session,
    output: (message) => outputs.push(message),
  });

  await commands.execute("/queue");
  await commands.execute("/queue resume");
  await commands.execute("/queue clear");

  assert.deepEqual(outputs, [
    "Pending: 2 (20 est. tokens) · Held: 1 (10 est. tokens) · Dead letters: 1",
    "Resumed 1 held message(s).",
    "Cleared 3 queued message(s).",
  ]);
});

test("/model current reports the active provider and model", async () => {
  const { commands, outputs } = makeCommands();

  const handled = await commands.execute("/model current");

  assert.equal(handled.status, "handled");
  assert.deepEqual(outputs, ["Current model: deepseek / deepseek-v4-flash"]);
});

test("/model opens the current provider model list", async () => {
  const prompts: string[] = [];
  const { commands, outputs, agent } = makeCommands({
    input: async (prompt) => {
      prompts.push(prompt);
      return "2";
    },
  });

  const handled = await commands.execute("/model");

  assert.equal(handled.status, "handled");
  assert.equal(agent.provider, "deepseek");
  assert.equal(agent.model, "deepseek-v4-pro");
  assert.equal(outputs.includes("Model providers:"), false);
  assert.ok(outputs.includes("Available models:"));
  assert.ok(outputs.includes("  2. deepseek-v4-pro - deepseek-v4-pro"));
  assert.deepEqual(prompts, ["Select model or search: "]);
});

test("/model with one non-provider argument selects a model on the current provider", async () => {
  const { commands, outputs, agent } = makeCommands();

  const handled = await commands.execute("/model deepseek-v4-pro");

  assert.equal(handled.status, "handled");
  assert.equal(agent.provider, "deepseek");
  assert.equal(agent.model, "deepseek-v4-pro");
  assert.deepEqual(agent.modelSwitches, [
    { provider: "deepseek", model: "deepseek-v4-pro" },
  ]);
  assert.ok(outputs.includes("Switched to deepseek / deepseek-v4-pro"));
});

test("/effort current reports the active reasoning effort", async () => {
  const { commands, outputs } = makeCommands();

  const handled = await commands.execute("/effort current");

  assert.equal(handled.status, "handled");
  assert.deepEqual(outputs, ["Current effort: high"]);
});

test("/effort sets a supported reasoning effort directly", async () => {
  const { commands, outputs, agent } = makeCommands();

  const handled = await commands.execute("/effort low");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "low");
  assert.deepEqual(outputs, [
    "Effort set to low. Applies to the next model request.",
  ]);
});

test("/effort rejects levels unsupported by the current model", async () => {
  const { commands, outputs, agent } = makeCommands();

  const handled = await commands.execute("/effort xhigh");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "high");
  assert.deepEqual(outputs, [
    "Effort xhigh is not supported by deepseek / deepseek-v4-flash. Supported: off, minimal, low, medium, high",
  ]);
});

test("/effort opens a numbered selector when no level is provided", async () => {
  const answers = ["4"];
  const { commands, outputs, agent } = makeCommands({
    input: async () => answers.shift() ?? "",
  });

  const handled = await commands.execute("/effort");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "medium");
  assert.deepEqual(outputs, [
    "Reasoning efforts for deepseek / deepseek-v4-flash:",
    "  1. off",
    "  2. minimal",
    "  3. low",
    "  4. medium",
    "  5. high",
    "Effort set to medium. Applies to the next model request.",
  ]);
});

test("/model switches provider and model without chatting", async () => {
  const agent = new FakeAgent({ model: "old-model", provider: "openai" });
  const { commands, outputs } = makeCommands({ agent });

  const handled = await commands.execute("/model deepseek deepseek-v4-pro");

  assert.equal(handled.status, "handled");
  assert.equal(agent.model, "deepseek-v4-pro");
  assert.equal(agent.provider, "deepseek");
  assert.deepEqual(agent.modelSwitches, [
    { provider: "deepseek", model: "deepseek-v4-pro" },
  ]);
  assert.ok(outputs.some((line) => line.includes("deepseek-v4-pro")));
});

test("/model adjusts effort when the selected model does not support the current level", async () => {
  const agent = new FakeAgent({ model: "deepseek-v4-pro", provider: "deepseek" });
  agent.setReasoningEffort("high");
  const { commands, outputs } = makeCommands({
    agent,
    configured: new Set(["deepseek", "anthropic"]),
  });

  const handled = await commands.execute("/model anthropic claude-sonnet-4-5");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "off");
  assert.ok(
    outputs.some((line) =>
      line ===
      "Reasoning effort adjusted to off for anthropic / claude-sonnet-4-5.",
    ),
  );
});

test("login applies credentials without replacing the running adapter", async () => {
  const { commands, auth, agent } = makeCommands({
    configured: new Set(),
  });

  await commands.execute("/login anthropic");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.deepEqual(agent.modelSwitches, []);
});

test("/login and /logout manage credentials through auth service", async () => {
  const { commands, auth, outputs } = makeCommands();

  await commands.execute("/login deepseek");
  await commands.execute("/apikey");
  await commands.execute("/logout anthropic");

  assert.deepEqual(auth.loginCalls, ["deepseek"]);
  assert.deepEqual(auth.logoutCalls, ["anthropic"]);
  assert.ok(outputs.some((line) => line === "deepseek: available, configured, unverified"));
});

test("/logout reports ambient credentials that remain configured", async () => {
  const { commands, auth, outputs } = makeCommands({
    ambientSources: new Map([["deepseek", "DEEPSEEK_API_KEY"]]),
  });

  await commands.execute("/logout deepseek");

  assert.deepEqual(auth.logoutCalls, ["deepseek"]);
  assert.ok(
    outputs.some((line) =>
      line ===
      "Removed stored credentials for deepseek, but it is still configured via DEEPSEEK_API_KEY.",
    ),
  );
  assert.equal(outputs.some((line) => line === "Logged out of deepseek."), false);
});

test("/apikey commands remain compatible aliases", async () => {
  const { commands, auth } = makeCommands();

  await commands.execute("/apikey set anthropic");
  await commands.execute("/apikey remove anthropic");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.deepEqual(auth.logoutCalls, ["anthropic"]);
});

test("/model does not prompt for missing credentials", async () => {
  const { commands, outputs } = makeCommands({
    configured: new Set(),
  });

  await commands.execute("/model anthropic claude-sonnet-4-5");

  assert.equal(
    outputs.some((line) => line.includes("Switched to anthropic")),
    false,
  );
});

test("/model reports unknown providers without switching", async () => {
  const { commands, outputs, agent } = makeCommands();

  await commands.execute("/model missing missing-model");

  assert.ok(outputs.some((line) => line.includes("Unknown provider: missing")));
  assert.equal(agent.modelSwitches.length, 0);
});
