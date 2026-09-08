import test from "node:test";
import assert from "node:assert/strict";

import type { ModelProviderInfo } from "@laohuang/llm";
import {
  CommandRegistry,
  SessionCommands,
  type SessionLike,
} from "../apps/cli/src/commands.ts";
import { ModelSelector } from "../apps/cli/src/model-selection.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";
import {
  createSessionCommandFixture,
  FakeAgent,
  FakeCatalog,
} from "./helpers/session-command-fixture.ts";

function providerInfo(
  id: string,
  options: { verified: boolean; name?: string },
): ModelProviderInfo {
  return {
    id,
    name: options.name ?? id,
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

test("help emits a structured help model", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });

  await commands.execute("/help");

  assert.ok(
    presenter.helpViews[0]?.commands.some((item) => item.name === "/model"),
  );
  assert.equal(
    presenter.notices.some((item) => item.text === "Commands:"),
    false,
  );
  assert.deepEqual(
    presenter.helpViews[0]?.commands.map((item) => item.name),
    [...(presenter.helpViews[0]?.commands.map((item) => item.name) ?? [])].sort(),
  );
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

test("session lifecycle commands delegate to the session controller", async () => {
  const presenter = new RecordingPresenter();
  const calls: string[] = [];
  const composerTexts: string[] = [];
  let sessionChanges = 0;
  const { commands } = createSessionCommandFixture({
    presenter,
    onComposerText: (text) => { composerTexts.push(text); },
    onSessionChanged: () => { sessionChanges += 1; },
    sessionController: {
      currentSessionId: "session-1",
      currentPath: "/tmp/session.jsonl",
      list: () => [{
        sessionId: "session-1",
        updatedAt: "2026-08-31T23:57:00.000Z",
        cwd: "/Users/huangxurui/data/code/laoHuangCode",
      }],
      createNew: async () => { calls.push("new"); },
      resume: async (sessionId: string) => { calls.push(`resume:${sessionId}`); },
      fork: async (entryId: string, mode: "before" | "at") => {
        calls.push(`fork:${entryId}:${mode}`);
        return { sessionId: "child", path: "/tmp/child.jsonl", editorText: "edit me" };
      },
      clone: async () => { calls.push("clone"); return { sessionId: "clone", path: "/tmp/clone.jsonl" }; },
      compact: async () => { calls.push("compact"); return {}; },
    },
  });

  await commands.execute("/session");
  await commands.execute("/sessions");
  await commands.execute("/new");
  await commands.execute("/resume session-2");
  await commands.execute("/fork entry-1 before");
  await commands.execute("/clone");
  await commands.execute("/compact");

  assert.deepEqual(calls, [
    "new",
    "resume:session-2",
    "fork:entry-1:before",
    "clone",
    "compact",
  ]);
  assert.deepEqual(composerTexts, ["edit me"]);
  assert.deepEqual(noticeTexts(presenter), [
    "Current session: session-1\nPath: /tmp/session.jsonl",
    "Untitled session\n3 minutes ago  ~/data/code/laoHuangCode",
    "Started a new session.",
    "Resumed session.",
    "Forked session child.",
    "Cloned session clone.",
    "Compacted current session.",
  ]);
  assert.equal(sessionChanges, 5);
});

test("compact reports an error when there is no summarizable context", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({
    presenter,
    sessionController: {
      currentSessionId: "session-1",
      currentPath: "/tmp/session.jsonl",
      list: () => [],
      createNew: async () => {},
      resume: async () => {},
      fork: async () => ({ sessionId: "child", path: "/tmp/child.jsonl", editorText: "" }),
      clone: async () => ({ sessionId: "clone", path: "/tmp/clone.jsonl" }),
      compact: async () => {
        throw new Error("No messages to compact in current history.");
      },
    },
  });

  const result = await commands.execute("/compact");

  assert.equal(result.status, "error");
  assert.match(
    result.status === "error" ? result.error.message : "",
    /No messages to compact in current history\./,
  );
  assert.deepEqual(presenter.notices, []);
});

test("resume without an id selects a recent session and restores it", async () => {
  const presenter = new RecordingPresenter({ selections: ["session-2"] });
  const calls: string[] = [];
  let sessionChanges = 0;
  const { commands } = createSessionCommandFixture({
    presenter,
    onSessionChanged: () => { sessionChanges += 1; },
    sessionController: {
      currentSessionId: "session-1",
      currentPath: "/tmp/session-1.jsonl",
      list: () => [
        {
          sessionId: "session-1",
          updatedAt: "2026-08-31T23:57:00.000Z",
          cwd: "/Users/huangxurui/data/code/laoHuangCode",
          title: "Current work",
          lastUserText: "current conversation",
        },
        {
          sessionId: "session-2",
          updatedAt: "2026-08-31T22:00:00.000Z",
          cwd: "/Users/huangxurui/data/code/laoHuangCode",
          lastUserText: "fix the build",
        },
      ],
      createNew: async () => {},
      resume: async (sessionId: string) => { calls.push(sessionId); },
      fork: async () => ({ sessionId: "child", path: "/tmp/child.jsonl", editorText: "" }),
      clone: async () => ({ sessionId: "clone", path: "/tmp/clone.jsonl" }),
      compact: async () => ({}),
    },
  });

  const result = await commands.execute("/resume");

  assert.equal(result.status, "handled");
  assert.deepEqual(presenter.selections, [{
    id: "session-resume",
    title: "Resume session",
    items: [
      {
        value: "session-1",
        label: "Current work",
        description: "3 minutes ago  ~/data/code/laoHuangCode",
      },
      {
        value: "session-2",
        label: "fix the build",
        description: "2 hours ago  ~/data/code/laoHuangCode",
      },
    ],
    currentValue: "session-1",
    searchable: true,
    searchPlaceholder: "Search sessions",
    maxVisible: 20,
  }]);
  assert.deepEqual(calls, ["session-2"]);
  assert.equal(sessionChanges, 1);
  assert.deepEqual(noticeTexts(presenter), ["Resumed session."]);
});

test("resume completes session ids with recent conversation details", () => {
  const { commands } = createSessionCommandFixture({
    presenter: new RecordingPresenter(),
    sessionController: {
      currentSessionId: "session-1",
      currentPath: "/tmp/session-1.jsonl",
      list: () => [
        {
          sessionId: "session-1",
          updatedAt: "2026-08-31T15:30:00.000Z",
          lastUserText: "current conversation",
        },
        {
          sessionId: "session-2",
          updatedAt: "2026-08-30T08:15:00.000Z",
          lastUserText: "fix the build",
        },
      ],
      createNew: async () => {},
      resume: async () => {},
      fork: async () => ({ sessionId: "child", path: "/tmp/child.jsonl", editorText: "" }),
      clone: async () => ({ sessionId: "clone", path: "/tmp/clone.jsonl" }),
      compact: async () => ({}),
    },
  });

  assert.deepEqual(commands.registry.complete("/resume session-2", { state: "IDLE" }), [{
    value: "session-2",
    description: "2026-08-30T08:15:00.000Z  fix the build",
    start: -9,
  }]);
  assert.deepEqual(
    commands.registry.complete("/resume session-2 ", { state: "IDLE" }),
    [],
  );
});

test("/clear is not a registered session command", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });

  assert.equal(
    commands.registry.all().some((command) => command.name === "/clear"),
    false,
  );
  assert.deepEqual(commands.registry.complete("/cle", { state: "IDLE" }), []);
  assert.deepEqual(await commands.execute("/clear"), {
    status: "not_found",
    command: "/clear",
  });
  assert.deepEqual(presenter.notices, []);
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
      providerInfo("anthropic", { verified: false, name: "Anthropic" }),
      providerInfo("deepseek", { verified: true, name: "DeepSeek" }),
    ],
    configured: new Set(["anthropic"]),
  });

  const result = await commands.execute("/providers");

  assert.equal(result.status, "handled");
  assert.deepEqual(presenter.providerViews[0]?.providers, [
    {
      id: "anthropic",
      name: "Anthropic",
      available: true,
      configured: true,
      verified: false,
      source: "stored credential",
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      available: true,
      configured: false,
      verified: true,
      source: null,
    },
  ]);
  assert.deepEqual(presenter.notices, []);

  await commands.execute("/providers anthropic");
  assert.deepEqual(presenter.providerDetails[0]?.provider, {
    id: "anthropic",
    name: "Anthropic",
    available: true,
    configured: true,
    verified: false,
    source: "stored credential",
    dynamicModels: false,
    modelCount: 1,
  });
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

  assert.deepEqual(presenter.queueViews, [{
    queue: {
      pending: 2,
      held: 1,
      pendingTokens: 20,
      heldTokens: 10,
      deadLetters: 1,
    },
  }]);
  assert.deepEqual(presenter.notices, [
    { text: "Resumed 1 held message(s).", tone: "success" },
    { text: "Cleared 3 queued message(s).", tone: "success" },
  ]);
});

test("cancel emits typed warning notices", async () => {
  const session: SessionLike = {
    queueStatus: () => ({}),
    clearQueues: () => 0,
    resumeHeld: () => 0,
    cancelActiveTask: () => false,
    submitAction: () => true,
  };
  const presenter = new RecordingPresenter();
  const { commands, agent } = createSessionCommandFixture({ presenter, session });
  agent.messages.push({ role: "user", content: "hello" });

  await commands.execute("/cancel");

  assert.deepEqual(presenter.notices, [
    { text: "Cancelling current task…", tone: "warning" },
  ]);
  assert.equal(agent.messages.length, 2);
});

test("blocked commands emit warning notices", async () => {
  const session: SessionLike = {
    activeTask: { state: "RUNNING_MODEL" },
    queueStatus: () => ({}),
    clearQueues: () => 0,
    resumeHeld: () => 0,
    cancelActiveTask: () => false,
    submitAction: () => false,
  };
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter, session });

  const result = await commands.execute("/new");

  assert.equal(result.status, "blocked");
  assert.deepEqual(presenter.notices, [{
    text: "/new is unavailable while the task is running_model.",
    tone: "warning",
  }]);
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
  const presenter = new RecordingPresenter({ selections: ["deepseek/deepseek-v4-pro"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });

  const handled = await commands.execute("/model");

  assert.equal(handled.status, "handled");
  assert.equal(presenter.selections.length, 1);
  assert.equal(presenter.selections[0]?.id, "model-name");
  assert.equal(presenter.selections[0]?.searchable, true);
  assert.equal(presenter.selections[0]?.currentValue, "deepseek/deepseek-v4-flash");
  assert.deepEqual(presenter.selections[0]?.items.map((item) => item.value), [
    "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro",
  ]);
  assert.deepEqual(presenter.selections[0]?.items[1], {
    value: "deepseek/deepseek-v4-pro",
    label: "deepseek-v4-pro",
    description: "deepseek",
  });
  assert.equal(agent.model, "deepseek-v4-pro");
});

test("/model reflects login and logout without restarting or changing the active route", async () => {
  const presenter = new RecordingPresenter();
  const { commands, agent } = createSessionCommandFixture({ presenter });

  await commands.execute("/login anthropic");
  await commands.execute("/model");
  assert.deepEqual(presenter.selections[0]?.items.map((item) => item.value), [
    "anthropic/claude-sonnet-4-5",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
  ]);

  await commands.execute("/logout anthropic");
  await commands.execute("/model");
  assert.deepEqual(presenter.selections[1]?.items.map((item) => item.value), [
    "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro",
  ]);
  assert.deepEqual(agent.modelSwitches, []);
});

test("/model selects the correct provider when model ids collide", async () => {
  const presenter = new RecordingPresenter({ selections: ["anthropic/shared/model"] });
  const { commands, catalog, agent } = createSessionCommandFixture({
    presenter, configured: new Set(["deepseek", "anthropic"]),
  });
  const template = catalog.listModels("deepseek")[0]!;
  catalog.models.set("deepseek", [{ ...template, id: "shared/model" }]);
  catalog.models.set("anthropic", [{ ...template, provider: "anthropic", id: "shared/model" }]);

  await commands.execute("/model");

  assert.deepEqual(presenter.selections[0]?.items.map((item) => item.value), [
    "anthropic/shared/model", "deepseek/shared/model",
  ]);
  assert.deepEqual(agent.modelSwitches, [{ provider: "anthropic", model: "shared/model" }]);
});

test("/model includes every model beyond the first twenty", async () => {
  const presenter = new RecordingPresenter({ selections: ["deepseek/model-29"] });
  const { commands, catalog, agent } = createSessionCommandFixture({ presenter });
  const template = catalog.listModels("deepseek")[0]!;
  catalog.models.set("deepseek", Array.from({ length: 30 }, (_, index) => ({
    ...template, id: `model-${String(index).padStart(2, "0")}`,
  })));

  await commands.execute("/model");

  assert.equal(presenter.selections[0]?.items.length, 30);
  assert.equal(agent.model, "model-29");
});

test("/model with no configured providers guides login without opening a selector", async () => {
  const presenter = new RecordingPresenter();
  const { commands, auth, agent } = createSessionCommandFixture({ presenter, configured: new Set() });

  await commands.execute("/model");

  assert.deepEqual(presenter.selections, []);
  assert.ok(noticeTexts(presenter).some((text) => text.includes("/login")));
  assert.deepEqual(auth.loginCalls, []);
  assert.deepEqual(agent.modelSwitches, []);
});

test("/model keeps healthy providers selectable when another catalog fails", async () => {
  const presenter = new RecordingPresenter({ selections: ["deepseek/deepseek-v4-pro"] });
  const { commands, catalog, agent } = createSessionCommandFixture({
    presenter, configured: new Set(["deepseek", "anthropic"]),
  });
  catalog.refresh = async (provider) => {
    if (provider === "anthropic") throw new Error("catalog unavailable");
  };

  await commands.execute("/model");

  assert.equal(agent.model, "deepseek-v4-pro");
  assert.ok(noticeTexts(presenter).some((text) => text.includes("anthropic") && text.includes("catalog unavailable")));
});

test("/model rejects a selection outside the available list", async () => {
  const presenter = new RecordingPresenter({ selections: ["anthropic/claude-sonnet-4-5"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });

  await commands.execute("/model");

  assert.deepEqual(agent.modelSwitches, []);
  assert.ok(presenter.notices.some((notice) => notice.tone === "error"));
});

test("explicit provider selection guides login when credentials are missing", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });

  await commands.execute("/model anthropic");

  assert.deepEqual(presenter.selections, []);
  assert.ok(noticeTexts(presenter).some((text) => text.includes("/login anthropic")));
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
  const presenter = new RecordingPresenter();
  const { commands, auth, agent } = createSessionCommandFixture({
    presenter,
    configured: new Set(),
  });

  await commands.execute("/login anthropic");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.deepEqual(agent.modelSwitches, []);
});

test("login selects an omitted provider through the presenter", async () => {
  const presenter = new RecordingPresenter({ selections: ["anthropic"] });
  const { commands, auth } = createSessionCommandFixture({ presenter });

  await commands.execute("/login");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.equal(presenter.selections[0]?.id, "auth-provider");
  assert.equal(
    presenter.notices.some((notice) => notice.text.includes("1. anthropic")),
    false,
  );
});

test("/logout reports ambient credentials that remain configured", async () => {
  const presenter = new RecordingPresenter();
  const { commands, auth } = createSessionCommandFixture({
    presenter,
    ambientSources: new Map([["deepseek", "DEEPSEEK_API_KEY"]]),
  });

  await commands.execute("/logout deepseek");

  assert.deepEqual(auth.logoutCalls, ["deepseek"]);
  assert.deepEqual(presenter.notices, [{
    text:
      "Removed stored credentials for deepseek, but it is still configured via DEEPSEEK_API_KEY.",
    tone: "warning",
  }]);
});

test("/apikey delegates to login, logout, and provider views without alias text", async () => {
  const presenter = new RecordingPresenter();
  const { commands, auth } = createSessionCommandFixture({
    presenter,
  });

  await commands.execute("/apikey set anthropic");
  await commands.execute("/apikey remove anthropic");
  await commands.execute("/apikey");

  assert.deepEqual(auth.loginCalls, ["anthropic"]);
  assert.deepEqual(auth.logoutCalls, ["anthropic"]);
  assert.equal(presenter.providerViews.length, 1);
  assert.equal(
    presenter.notices.some((notice) =>
      notice.text === "Use /login or /logout to manage credentials."
    ),
    false,
  );
});

test("login cancellation and service failures use warning and error notices", async () => {
  const providers = [providerInfo("anthropic", {
    verified: false,
    name: "Anthropic",
  })];
  const catalog = new FakeCatalog(providers);
  const presenter = new RecordingPresenter();
  let loginResult: { configured: boolean; source?: string } | null = {
    configured: true,
    source: "stored credential",
  };
  let loginError: Error | null = null;
  const providerAuth = {
    status: async () => ({ configured: false }),
    login: async () => {
      if (loginError !== null) {
        throw loginError;
      }
      return loginResult;
    },
    logout: async () => {},
    ensureConfigured: async () => false,
  };
  const commands = new SessionCommands({
    agent: new FakeAgent({ model: "claude-sonnet-4-5", provider: "anthropic" }),
    selector: new ModelSelector({ catalog, providerAuth }),
    catalog,
    providerAuth,
    currentConfig: {
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      baseUrl: null,
    },
    presenter,
  });

  await commands.execute("/login anthropic");
  loginResult = null;
  await commands.execute("/login anthropic");
  loginError = new Error("credential store unavailable");
  await commands.execute("/login anthropic");

  assert.deepEqual(presenter.notices, [
    { text: "Logged in to anthropic; use /model to select it.", tone: "success" },
    { text: "Login cancelled; credentials were not changed.", tone: "warning" },
    { text: "Login failed for anthropic: credential store unavailable", tone: "error" },
  ]);
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
