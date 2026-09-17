import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { ConfigManager, CredentialStore, ModelCatalogStore } from "@laohuang/local-config";
import { CustomModelsStore } from "../packages/storage/local-config/src/custom-models.ts";
import { createPiAiPlatform } from "../packages/llm/llm-pi-ai/src/platform.ts";
import { CustomModelRegistry } from "../packages/llm/llm-pi-ai/src/custom-models.ts";
import { parseCustomModels } from "../packages/llm/llm-pi-ai/src/custom-model-schema.ts";
import { SessionCommands } from "../apps/cli/src/commands.ts";
import { ModelSelector } from "../apps/cli/src/model-selection.ts";
import { ProviderAuthController } from "../apps/cli/src/provider-auth.ts";
import { main } from "../apps/cli/src/main.ts";
import { FakeAgent } from "./helpers/session-command-fixture.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

const definition = (id = "relay-model") => ({ id, contextWindow: 128000, maxTokens: 8192 });
const provider = (baseUrl = "https://relay.example/v1") => ({
  api: "openai-completions", baseUrl, models: [definition()],
});

async function fixture(t: test.TestContext, initial: unknown = { providers: { relay: provider() } }) {
  const directory = await mkdtemp(join(tmpdir(), "laohuang-custom-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "custom-models.json");
  await writeFile(path, JSON.stringify(initial));
  const store = new CustomModelsStore(path);
  const credentials = new CredentialStore(join(directory, "credentials.json"));
  const environ: Record<string, string | undefined> = {};
  const platform = await createPiAiPlatform({
    credentials, modelCatalogStore: new ModelCatalogStore(join(directory, "models.json")),
    excludedProviderIds: new Set(["amazon-bedrock", "google-vertex"]),
    verifiedProviderIds: new Set(["deepseek"]),
    readCustomModels: () => store.read(), environ,
  });
  return { directory, path, store, credentials, platform, environ };
}

test("custom model store handles absent files and redacts malformed JSON", async t => {
  const f = await fixture(t);
  await rm(f.path);
  assert.equal(await f.store.read(), undefined);
  await writeFile(f.path, '{"secret-key-never-echo"');
  await assert.rejects(f.store.read(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Invalid JSON/);
    assert.ok(!error.message.includes("secret-key-never-echo"));
    return true;
  });
});

test("configuration rejects unknown fields, invalid values and command credentials", () => {
  for (const invalid of [
    null, [], { providers: [] }, { providers: { "bad/id": provider() } },
    { providers: { constructor: provider() } },
    { providers: { relay: { ...provider(), apiKey: "!echo secret" } } },
    { providers: { relay: { ...provider(), api: "private-api" } } },
    { providers: { relay: { ...provider(), models: [{ ...definition(), contextWindow: -1 }] } } },
    { providers: { relay: { ...provider(), models: [{ ...definition(), reasoning: "yes" }] } } },
    { providers: { relay: { ...provider(), models: [{ ...definition(), thinkingLevelMap: { wrong: "high" } }] } } },
  ]) assert.throws(() => parseCustomModels(invalid), /Custom models/, JSON.stringify(invalid));
});

test("custom provider joins catalog, login persists credentials, logout hides availability", async t => {
  const { platform, credentials } = await fixture(t);
  assert.ok(platform.catalog.getProvider("relay"));
  assert.equal(platform.catalog.getProvider("relay")?.verified, false);
  assert.equal(platform.catalog.getModel("relay", "relay-model")?.contextWindow, 128000);
  assert.deepEqual(await platform.catalog.listAvailableModels("relay"), []);
  await platform.auth.loginApiKey("relay", { prompt: async () => "fake-relay-key", notify: () => {} });
  assert.equal((await credentials.read("relay"))?.key, "fake-relay-key");
  assert.equal((await platform.catalog.listAvailableModels("relay")).length, 1);
  await platform.auth.logout("relay");
  assert.deepEqual(await platform.catalog.listAvailableModels("relay"), []);
});

test("environment key reference is resolved without storing it", async t => {
  const f = await fixture(t, { providers: { relay: { ...provider(), apiKeyEnv: "RELAY_KEY" } } });
  assert.deepEqual(await f.platform.auth.status("relay"), { configured: false });
  f.environ.RELAY_KEY = "env-test-key";
  assert.deepEqual(await f.platform.auth.status("relay"), { configured: true, source: "RELAY_KEY" });
  assert.equal(await f.credentials.read("relay"), undefined);
  await f.platform.auth.loginApiKey("relay", { prompt: async () => "stored-test-key", notify: () => {} });
  assert.deepEqual(await f.platform.auth.status("relay"), { configured: true, source: "stored credential" });
});

test("built-in models merge by ID, retain capabilities, and revert when config is removed", async t => {
  const f = await fixture(t, { providers: { deepseek: {
    models: [{ id: "deepseek-v4-flash", name: "My Flash" }, {
      ...definition("deepseek-flash"), api: "openai-completions", reasoning: true, input: ["text", "image"],
      thinkingLevelMap: { minimal: null, medium: null, low: "low", high: "high", max: "max", xhigh: null },
      compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false },
    }],
  } } });
  assert.equal(f.platform.catalog.listModels("deepseek").length, 4);
  assert.equal(f.platform.catalog.getModel("deepseek", "deepseek-v4-flash")?.name, "My Flash");
  assert.equal(f.platform.catalog.getModel("deepseek", "deepseek-v4-flash")?.reasoning, true);
  assert.deepEqual(f.platform.catalog.getModel("deepseek", "deepseek-flash")?.input, ["text", "image"]);
  assert.equal(f.platform.catalog.getProvider("deepseek")?.verified, false);
  await f.platform.catalog.refresh("deepseek");
  assert.ok(f.platform.catalog.getModel("deepseek", "deepseek-flash"));
  await rm(f.path);
  await f.platform.catalog.reload!();
  assert.equal(f.platform.catalog.listModels("deepseek").length, 3);
  assert.equal(f.platform.catalog.getProvider("deepseek")?.verified, true);
  assert.equal(f.platform.catalog.getModel("deepseek", "deepseek-v4-flash")?.name, "DeepSeek V4 Flash");
});

test("reload is atomic, recovers after errors, and removes deleted providers", async t => {
  const f = await fixture(t);
  for (const bad of [
    { ...provider(), compat: { thinkingFormat: "invalid" } },
    { ...provider(), models: [definition(), definition()] },
    { ...provider(), models: [{ id: "missing-limits" }] },
    { ...provider(), baseUrl: "https://secret:secret@relay.example" },
    { ...provider(), headers: { Authorization: "secret" } },
  ]) {
    await writeFile(f.path, JSON.stringify({ providers: { added: provider(), relay: bad } }));
    await assert.rejects(f.platform.catalog.reload!(), /Custom models/);
    assert.equal(f.platform.catalog.getProvider("added"), undefined);
    assert.ok(f.platform.catalog.getModel("relay", "relay-model"));
  }
  await writeFile(f.path, JSON.stringify({ providers: { replacement: provider() } }));
  await f.platform.catalog.reload!();
  assert.equal(f.platform.catalog.getProvider("relay"), undefined);
  assert.ok(f.platform.catalog.getProvider("replacement"));
  await assert.rejects(f.platform.adapter.runAttempt({
    provider: "replacement", model: "not-defined", messages: [], tools: [],
  }), /unknown model route/);
});

test("excluded and OAuth-only providers cannot be enabled through custom definitions", async t => {
  const f = await fixture(t);
  for (const id of ["amazon-bedrock", "google-vertex", "openai-codex"]) {
    await writeFile(f.path, JSON.stringify({ providers: { [id]: provider() } }));
    await assert.rejects(f.platform.catalog.reload!(), /excluded|authentication/);
  }
});

test("dynamic refresh keeps user overrides and adds newly discovered models", async () => {
  const models = createModels();
  const baseModel: Model<"openai-completions"> = {
    ...definition("dynamic-model"), provider: "dynamic", name: "Original", api: "openai-completions",
    baseUrl: "https://dynamic.example/v1", input: ["text"], reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const noStream = () => { throw new Error("no requests in catalog test"); };
  let current = [baseModel];
  const base = createProvider({ id: "dynamic", auth: { apiKey: envApiKeyAuth("key", []) }, models: [baseModel],
    api: { stream: noStream, streamSimple: noStream } });
  models.setProvider({ ...base, getModels: () => current, refreshModels: async context => {
    await context.publish({ update: () => { current = [baseModel, { ...baseModel, id: "discovered" }]; } });
  } });
  let document: unknown = { providers: { dynamic: { models: [{ id: "dynamic-model", name: "Override" }] } } };
  const registry = new CustomModelRegistry(models, new Set(), async () => document);
  await registry.reload();
  await models.refresh({ allowNetwork: false });
  assert.equal(models.getModel("dynamic", "dynamic-model")?.name, "Override");
  assert.ok(models.getModel("dynamic", "discovered"));
  document = undefined;
  await registry.reload();
  assert.equal(models.getModel("dynamic", "dynamic-model")?.name, "Original");
  assert.ok(models.getModel("dynamic", "discovered"));
});

test("model command reloads definitions before resolving new provider, and login works", async t => {
  const f = await fixture(t, undefined);
  const auth = new ProviderAuthController({ auth: f.platform.auth });
  const presenter = new RecordingPresenter({ prompts: ["fake-key"], selections: ["new-relay/relay-model"] });
  const agent = new FakeAgent({ provider: "deepseek", model: "deepseek-v4-flash" });
  const commands = new SessionCommands({ agent, selector: new ModelSelector({ catalog: f.platform.catalog, providerAuth: auth }),
    catalog: f.platform.catalog, providerAuth: auth, currentConfig: { provider: agent.provider, model: agent.model, baseUrl: null },
    presenter, copyText: async () => ({ status: "copied" }),
  });
  await writeFile(f.path, JSON.stringify({ providers: { "new-relay": provider() } }));
  assert.equal((await commands.execute("/login new-relay")).status, "handled");
  assert.equal((await commands.execute("/model new-relay")).status, "handled");
  assert.equal(agent.provider, "new-relay");
  assert.equal(agent.model, "relay-model");
  assert.ok(presenter.selections[0]?.items.some(item => item.value === "new-relay/relay-model"));
  await writeFile(f.path, "broken");
  assert.equal((await commands.execute("/model")).status, "error");
  assert.equal(agent.provider, "new-relay");
});

test("CLI config and doctor accept a custom provider without making model calls", async t => {
  const f = await fixture(t);
  const configPath = join(f.directory, "config.json");
  const output: string[] = [];
  const options = { configPath, environ: {}, outputFn: (s: string) => output.push(s),
    secretInputFn: () => "cli-fake-key", inputFn: () => { throw new Error("unexpected input"); } };
  assert.equal(await main(["config", "--provider", "relay", "--model", "relay-model"], options), 0);
  assert.equal(new ConfigManager(configPath).listProfiles()[0]?.provider, "relay");
  assert.equal(await main(["doctor"], options), 0);
  assert.ok(output.some(line => line === "Model: relay-model"));
  assert.ok(!output.join("\n").includes("cli-fake-key"));
  assert.ok(!(await readFile(f.path, "utf8")).includes("cli-fake-key"));
});

test("custom completions model sends declared parameters and isolated credentials to a local server", async t => {
  const requests: Array<{ body: Record<string, unknown>; auth: string | undefined; path: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), auth: request.headers.authorization, path: request.url });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "relay-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const f = await fixture(t, { providers: { relay: { ...provider(baseUrl), models: [{
    ...definition(), reasoning: true, thinkingLevelMap: { high: "high" },
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  }] } } });
  await f.credentials.modify("relay", async () => ({ type: "api_key", key: "relay-only-key" }));
  await f.credentials.modify("deepseek", async () => ({ type: "api_key", key: "never-send-this-key" }));
  const result = await f.platform.adapter.runAttempt({ provider: "relay", model: "relay-model", reasoningEffort: "high",
    messages: [{ role: "system", content: "test system" }, { role: "user", content: "test input" }], tools: [], maxOutputTokens: 32,
  });
  assert.equal(result.message.content[0]?.type, "text");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.auth, "Bearer relay-only-key");
  assert.equal(requests[0]?.path, "/v1/chat/completions");
  assert.equal(requests[0]?.body.model, "relay-model");
  assert.equal(requests[0]?.body.max_tokens, 32);
  assert.deepEqual(requests[0]?.body.thinking, { type: "enabled" });
  assert.equal(requests[0]?.body.reasoning_effort, "high");
  assert.equal((requests[0]?.body.messages as Array<{ role: string }>)[0]?.role, "system");
  await writeFile(f.path, JSON.stringify({ providers: { relay: {
    ...provider(`http://127.0.0.1:${address.port}/changed`), models: [definition("new-model")],
  } } }));
  await f.platform.catalog.reload!();
  await assert.rejects(f.platform.adapter.runAttempt({ provider: "relay", model: "relay-model", messages: [], tools: [] }), /unknown model/);
  await f.platform.adapter.runAttempt({ provider: "relay", model: "new-model", messages: [{ role: "user", content: "hello" }], tools: [] });
  assert.equal(requests[1]?.path, "/changed/chat/completions");
  assert.equal(requests[1]?.body.model, "new-model");
});

test("mixed custom protocols select their native endpoints and authentication headers", async t => {
  const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    // A deterministic rejection is sufficient to inspect wire dispatch; no external API is called.
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "local fixture rejection", type: "invalid_request_error", code: 400 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const f = await fixture(t, { providers: { relay: {
    baseUrl: `http://127.0.0.1:${address.port}`,
    models: [
      { ...definition("responses-model"), api: "openai-responses", compat: { supportsDeveloperRole: false } },
      { ...definition("anthropic-model"), api: "anthropic-messages" },
      { ...definition("google-model"), api: "google-generative-ai" },
    ],
  } } });
  await f.credentials.modify("relay", async () => ({ type: "api_key", key: "protocol-test-key" }));
  for (const model of ["responses-model", "anthropic-model", "google-model"]) {
    await assert.rejects(f.platform.adapter.runAttempt({ provider: "relay", model,
      messages: [{ role: "user", content: "hello" }], tools: [], reasoningEffort: "off",
    }));
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.path, "/responses");
  assert.equal(requests[0]?.headers.authorization, "Bearer protocol-test-key");
  assert.equal(requests[0]?.body.model, "responses-model");
  assert.match(requests[1]?.path ?? "", /^\/v1\/messages/);
  assert.equal(requests[1]?.headers["x-api-key"], "protocol-test-key");
  assert.equal(requests[1]?.body.model, "anthropic-model");
  assert.match(requests[2]?.path ?? "", /models\/google-model:streamGenerateContent/);
  assert.equal(requests[2]?.headers["x-goog-api-key"], "protocol-test-key");
});

test("reload does not run during an active model task, but refreshes active metadata when idle", async t => {
  const f = await fixture(t);
  const auth = new ProviderAuthController({ auth: f.platform.auth });
  const agent = new FakeAgent({ provider: "relay", model: "relay-model" });
  let activeTask: { state: string } | null = { state: "RUNNING_MODEL" };
  let refreshedWindow: number | undefined;
  const commands = new SessionCommands({ agent,
    selector: new ModelSelector({ catalog: f.platform.catalog, providerAuth: auth }),
    catalog: f.platform.catalog, providerAuth: auth, currentConfig: { provider: "relay", model: "relay-model", baseUrl: null },
    presenter: new RecordingPresenter(), copyText: async () => ({ status: "copied" }),
    session: { get activeTask() { return activeTask; }, cancelActiveTask: () => false, submitAction: () => false,
      clearQueues: () => 0, resumeHeld: () => 0, queueStatus: () => ({ pending: 0, held: 0, deadLetters: 0 }) },
    onModelSelected: () => { refreshedWindow = f.platform.catalog.getModel("relay", "relay-model")?.contextWindow; },
  });
  await writeFile(f.path, JSON.stringify({ providers: { relay: {
    ...provider(), models: [{ ...definition(), contextWindow: 64000 }],
  } } }));
  assert.equal((await commands.execute("/model")).status, "blocked");
  assert.equal(f.platform.catalog.getModel("relay", "relay-model")?.contextWindow, 128000);
  activeTask = null;
  await commands.execute("/model");
  assert.equal(refreshedWindow, 64000);
});
