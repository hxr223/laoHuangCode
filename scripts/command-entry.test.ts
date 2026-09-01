import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandRegistry,
  SessionCommands,
  type AgentLike,
  type SessionLike,
} from "../apps/cli/src/commands.ts";
import { ModelSelector } from "../apps/cli/src/model-selection.ts";
import type {
  ModelAuthStatus,
  ModelCatalog,
  ModelInfo,
  ModelProviderInfo,
} from "@laohuang/llm";
import type { ProviderAuthController } from "../apps/cli/src/provider-auth.ts";
import { TerminalUI } from "../packages/terminal/tui/src/index.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

const providers: readonly ModelProviderInfo[] = [{
  id: "deepseek",
  name: "DeepSeek",
  authName: "DeepSeek API key",
  dynamicModels: false,
  verified: false,
}];
const models: readonly ModelInfo[] = [{
  provider: "deepseek",
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 2048,
}];
const catalog: ModelCatalog = {
  listProviders: () => providers,
  getProvider: (provider) =>
    providers.find((item) => item.id === provider),
  listModels: (provider) =>
    models.filter((item) => item.provider === provider),
  listAvailableModels: async (provider) =>
    models.filter((item) => item.provider === provider),
  getModel: (provider, model) =>
    models.find((item) => item.provider === provider && item.id === model),
  refresh: async () => {},
};
const providerAuth = {
  status: async (): Promise<ModelAuthStatus> => ({
    configured: true,
    source: "stored credential",
  }),
  login: async () => true,
  logout: async () => {},
  ensureConfigured: async () => true,
} satisfies Pick<
  ProviderAuthController,
  "status" | "login" | "logout" | "ensureConfigured"
>;

class FakeAgent implements AgentLike {
  messages: unknown[] = [{ role: "system", content: "system prompt" }];

  switchModel(): void {}

  clearHistory(): void {
    this.messages.splice(1);
  }
}

function makeCommands(options: { session?: SessionLike | null } = {}): {
  commands: SessionCommands;
  presenter: RecordingPresenter;
} {
  const presenter = new RecordingPresenter();
  const commands = new SessionCommands({
    agent: new FakeAgent(),
    selector: new ModelSelector({
      catalog,
      providerAuth,
      input: async () => "",
      output: () => {},
    }),
    catalog,
    providerAuth,
    currentConfig: {
      baseUrl: null,
      model: "deepseek-v4-flash",
      provider: "deepseek",
    },
    presenter,
    session: options.session ?? null,
  });
  return { commands, presenter };
}

function noticeTexts(presenter: RecordingPresenter): string[] {
  return presenter.notices.map((notice) => notice.text);
}

test("typed cancel submits a neutral cancellation action", async () => {
  const actions: unknown[] = [];
  const { commands, presenter } = makeCommands({
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
  assert.deepEqual(noticeTexts(presenter), ["Cancelling current task…"]);
});

test("keyboard cancellation reaches the neutral cancellation action", async () => {
  const actions: unknown[] = [];
  const { commands, presenter } = makeCommands({
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
  assert.deepEqual(noticeTexts(presenter), ["Cancelling current task…"]);
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

test("command entry reports clear as an unknown command", async () => {
  const { commands, presenter } = makeCommands({
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

  assert.deepEqual(result, { status: "not_found", command: "/clear" });
  assert.deepEqual(noticeTexts(presenter), []);
});

test("command entry permits model current while a task runs", async () => {
  const { commands, presenter } = makeCommands({
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
  assert.deepEqual(noticeTexts(presenter), [
    "Current model: deepseek / deepseek-v4-flash",
  ]);
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
