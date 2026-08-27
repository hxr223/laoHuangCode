import test from "node:test";
import assert from "node:assert/strict";

import type { ModelProviderInfo } from "@laohuang/llm";
import {
  CommandRegistry,
  type SessionLike,
} from "../apps/cli/src/commands.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";
import {
  createSessionCommandFixture,
  FakeAgent,
} from "./helpers/session-command-fixture.ts";

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

function noticeTexts(presenter: RecordingPresenter): string[] {
  return presenter.notices.map((notice) => notice.text);
}

test("session commands retain their command presentation port", () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });

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
  const { commands } = createSessionCommandFixture({
    presenter: new RecordingPresenter(),
  });

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
  const { commands } = createSessionCommandFixture({
    presenter: new RecordingPresenter(),
  });

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
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({
    presenter,
    providers: [
      providerInfo("anthropic", { verified: false }),
      providerInfo("deepseek", { verified: true }),
    ],
    configured: new Set(["anthropic"]),
  });

  const result = await commands.execute("/providers");

  assert.equal(result.status, "handled");
  assert.deepEqual(noticeTexts(presenter), [
    "anthropic: available, configured, unverified",
    "deepseek: available, not configured, verified",
  ]);

  await commands.execute("/providers anthropic");
  assert.ok(noticeTexts(presenter).some((line) => line.includes("Authentication: configured")));
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
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({
    presenter,
    session,
  });

  await commands.execute("/queue");
  await commands.execute("/queue resume");
  await commands.execute("/queue clear");

  assert.deepEqual(noticeTexts(presenter), [
    "Pending: 2 (20 est. tokens) · Held: 1 (10 est. tokens) · Dead letters: 1",
    "Resumed 1 held message(s).",
    "Cleared 3 queued message(s).",
  ]);
});

test("/model current reports the active provider and model", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/model current");

  assert.equal(handled.status, "handled");
  assert.deepEqual(presenter.notices, [{
    text: "Current model: deepseek / deepseek-v4-flash",
    tone: "info",
  }]);
});

test("model command opens searchable component requests", async () => {
  const presenter = new RecordingPresenter({ selections: ["deepseek", "deepseek-v4-pro"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/model");

  assert.equal(handled.status, "handled");
  assert.equal(presenter.selections[0]?.id, "model-provider");
  assert.equal(presenter.selections[1]?.id, "model-name");
  assert.equal(presenter.selections[1]?.searchable, true);
  assert.deepEqual(presenter.selections[1]?.items[1], {
    value: "deepseek/deepseek-v4-pro",
    label: "deepseek-v4-pro",
    description: "deepseek",
  });
  assert.equal(agent.model, "deepseek-v4-pro");
});

test("/model with one non-provider argument selects a model on the current provider", async () => {
  const presenter = new RecordingPresenter();
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/model deepseek-v4-pro");

  assert.equal(handled.status, "handled");
  assert.equal(agent.provider, "deepseek");
  assert.equal(agent.model, "deepseek-v4-pro");
  assert.deepEqual(agent.modelSwitches, [
    { provider: "deepseek", model: "deepseek-v4-pro" },
  ]);
  assert.ok(presenter.notices.some((notice) =>
    notice.text === "Switched to deepseek / deepseek-v4-pro" && notice.tone === "success"
  ));
});

test("/effort current reports the active reasoning effort", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/effort current");

  assert.equal(handled.status, "handled");
  assert.deepEqual(presenter.notices, [{ text: "Current effort: high", tone: "info" }]);
});

test("/effort sets a supported reasoning effort directly", async () => {
  const presenter = new RecordingPresenter();
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/effort low");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "low");
  assert.deepEqual(presenter.notices, [{
    text: "Effort set to low. Applies to the next model request.",
    tone: "success",
  }]);
});

test("/effort rejects levels unsupported by the current model", async () => {
  const presenter = new RecordingPresenter();
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/effort xhigh");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "high");
  assert.deepEqual(presenter.notices, [{
    text: "Effort xhigh is not supported by deepseek / deepseek-v4-flash. Supported: off, minimal, low, medium, high",
    tone: "error",
  }]);
});

test("effort command selects only supported values", async () => {
  const presenter = new RecordingPresenter({ selections: ["medium"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });

  await commands.execute("/effort");

  assert.deepEqual(
    presenter.selections[0]?.items.map((item) => item.value),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.equal(presenter.selections[0]?.currentValue, "high");
  assert.equal(agent.reasoningEffort, "medium");
});

test("effort command rejects a presenter value unsupported by the model", async () => {
  const presenter = new RecordingPresenter({ selections: ["xhigh"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });

  await commands.execute("/effort");

  assert.equal(agent.reasoningEffort, "high");
  assert.deepEqual(presenter.notices, [{
    text: "Effort xhigh is not supported by deepseek / deepseek-v4-flash. Supported: off, minimal, low, medium, high",
    tone: "error",
  }]);
});

test("/model switches provider and model without chatting", async () => {
  const agent = new FakeAgent({ model: "old-model", provider: "openai" });
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter, agent });

  const handled = await commands.execute("/model deepseek deepseek-v4-pro");

  assert.equal(handled.status, "handled");
  assert.equal(agent.model, "deepseek-v4-pro");
  assert.equal(agent.provider, "deepseek");
  assert.deepEqual(agent.modelSwitches, [
    { provider: "deepseek", model: "deepseek-v4-pro" },
  ]);
  assert.ok(presenter.notices.some((notice) => notice.text.includes("deepseek-v4-pro")));
});

test("/model adjusts effort when the selected model does not support the current level", async () => {
  const agent = new FakeAgent({ model: "deepseek-v4-pro", provider: "deepseek" });
  agent.setReasoningEffort("high");
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({
    presenter,
    agent,
    configured: new Set(["deepseek", "anthropic"]),
  });

  const handled = await commands.execute("/model anthropic claude-sonnet-4-5");

  assert.equal(handled.status, "handled");
  assert.equal(agent.reasoningEffort, "off");
  assert.ok(
    presenter.notices.some((notice) =>
      notice.text ===
      "Reasoning effort adjusted to off for anthropic / claude-sonnet-4-5.",
    ),
  );
});

test("login applies credentials without replacing the running adapter", async () => {
  const { commands, auth, agent } = createSessionCommandFixture({
    presenter: new RecordingPresenter(),
    configured: new Set(),
  });

  await commands.execute("/login anthropic");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.deepEqual(agent.modelSwitches, []);
});

test("/login and /logout manage credentials through auth service", async () => {
  const presenter = new RecordingPresenter();
  const { commands, auth } = createSessionCommandFixture({ presenter });

  await commands.execute("/login deepseek");
  await commands.execute("/apikey");
  await commands.execute("/logout anthropic");

  assert.deepEqual(auth.loginCalls, ["deepseek"]);
  assert.deepEqual(auth.logoutCalls, ["anthropic"]);
  assert.ok(noticeTexts(presenter).some((line) =>
    line === "deepseek: available, configured, unverified"
  ));
});

test("/logout reports ambient credentials that remain configured", async () => {
  const presenter = new RecordingPresenter();
  const { commands, auth } = createSessionCommandFixture({
    presenter,
    ambientSources: new Map([["deepseek", "DEEPSEEK_API_KEY"]]),
  });

  await commands.execute("/logout deepseek");

  assert.deepEqual(auth.logoutCalls, ["deepseek"]);
  assert.ok(
    noticeTexts(presenter).some((line) =>
      line ===
      "Removed stored credentials for deepseek, but it is still configured via DEEPSEEK_API_KEY.",
    ),
  );
  assert.equal(noticeTexts(presenter).some((line) => line === "Logged out of deepseek."), false);
});

test("/apikey commands remain compatible aliases", async () => {
  const { commands, auth } = createSessionCommandFixture({
    presenter: new RecordingPresenter(),
  });

  await commands.execute("/apikey set anthropic");
  await commands.execute("/apikey remove anthropic");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.deepEqual(auth.logoutCalls, ["anthropic"]);
});

test("/model does not prompt for missing credentials", async () => {
  const presenter = new RecordingPresenter();
  const { commands, auth } = createSessionCommandFixture({
    presenter,
    configured: new Set(),
  });

  await commands.execute("/model anthropic claude-sonnet-4-5");

  assert.deepEqual(auth.ensureConfiguredCalls, [{
    provider: "anthropic",
    promptIfMissing: false,
    hasPrompts: false,
  }]);
  assert.equal(
    presenter.notices.some((notice) => notice.text.includes("Switched to anthropic")),
    false,
  );
});

test("/model reports unknown providers without switching", async () => {
  const presenter = new RecordingPresenter();
  const { commands, agent } = createSessionCommandFixture({ presenter });

  await commands.execute("/model missing missing-model");

  assert.ok(presenter.notices.some((notice) =>
    notice.text.includes("Unknown provider: missing") && notice.tone === "error"
  ));
  assert.equal(agent.modelSwitches.length, 0);
});
