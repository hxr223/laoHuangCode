import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelError,
  type ApiKeySetupInteraction,
  type ModelPlatform,
} from "@laohuang/llm";
import type {
  Api,
  AssistantMessageEvent,
  AuthCheck,
  AuthResult,
  Credential,
  CredentialInfo,
  Model,
  OAuthCredential,
  Provider,
} from "@earendil-works/pi-ai";
import {
  InMemoryModelsStore,
  createModels,
  defaultProviderAuthContext,
} from "@earendil-works/pi-ai";
import type {
  ApiKeyCredential,
  StoredModelCatalogEntry,
} from "@laohuang/local-config";
import {
  type ApiKeyCredentialStoreLike,
  type ModelCatalogStoreLike,
  PiAiPlatform,
  createPiAiPlatform,
} from "../packages/llm/llm-pi-ai/src/index.ts";

test("platform exposes eligible api-key providers and hides exclusions", () => {
  const platform = makePlatformWithProviders([
    fakeProvider("deepseek", { apiKey: true }),
    fakeProvider("anthropic", { apiKey: true, oauth: true }),
    fakeProvider("openai-codex", { oauth: true }),
    fakeProvider("amazon-bedrock", { apiKey: true }),
    fakeProvider("google-vertex", { apiKey: true }),
  ]);

  assert.deepEqual(
    platform.catalog.listProviders().map((provider) => provider.id),
    ["anthropic", "deepseek"],
  );
});

test("api-key login stores every provider-owned setup field", async () => {
  const prompts: string[] = [];
  const { platform, credentials } = await makeCloudflarePlatform();
  const answers = ["cf-secret", "account-1", "gateway-1"];

  const status = await platform.auth.loginApiKey("cloudflare-ai-gateway", {
    prompt: async (prompt) => {
      prompts.push(prompt.message);
      return answers.shift()!;
    },
    notify: () => {},
  });

  assert.deepEqual(status, { configured: true, source: "stored credential" });
  assert.deepEqual(await credentials.read("cloudflare-ai-gateway"), {
    type: "api_key",
    key: "cf-secret",
    env: {
      CLOUDFLARE_ACCOUNT_ID: "account-1",
      CLOUDFLARE_GATEWAY_ID: "gateway-1",
    },
  });
  assert.equal(prompts.length, 3);
});

test("ambient api-key auth is configured without storing a credential", async () => {
  const previous = process.env["DEEPSEEK_API_KEY"];
  process.env["DEEPSEEK_API_KEY"] = "environment-test-key";
  try {
    const platform = await createPiAiPlatform({
      credentials: new MemoryCredentials(),
      modelCatalogStore: new MemoryCatalogStore(),
      excludedProviderIds: new Set(["amazon-bedrock", "google-vertex"]),
      verifiedProviderIds: new Set(),
    });
    assert.deepEqual(await platform.auth.status("deepseek"), {
      configured: true,
      source: "DEEPSEEK_API_KEY",
    });
  } finally {
    if (previous === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = previous;
  }
});

test("verified evidence decorates status but never enables a provider", () => {
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const authContext = defaultProviderAuthContext();
  const models = createModels({ credentials, modelsStore, authContext });
  models.setProvider(fakeProvider("deepseek", { apiKey: true }));
  const platform = new PiAiPlatform(models, {
    credentials,
    modelsStore,
    authContext,
    excludedProviderIds: new Set(["deepseek"]),
    verifiedProviderIds: new Set(["deepseek"]),
  });
  assert.deepEqual(platform.catalog.listProviders(), []);
  assert.equal(platform.catalog.getProvider("deepseek"), undefined);
  assert.equal(platform.catalog.getModel("deepseek", "deepseek-model"), undefined);
});

test("api-key auth rejects an OAuth-only interaction event", async () => {
  const provider = fakeProvider("bad-api-key-provider", { apiKey: true });
  provider.auth.apiKey!.login = async (interaction) => {
    await interaction.prompt({
      type: "manual_code",
      message: "Enter OAuth code",
    });
    return { type: "api_key", key: "never-stored" };
  };
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const authContext = defaultProviderAuthContext();
  const models = createModels({ credentials, modelsStore, authContext });
  models.setProvider(provider);
  const platform = new PiAiPlatform(models, {
    credentials,
    modelsStore,
    authContext,
    excludedProviderIds: new Set(),
    verifiedProviderIds: new Set(),
  });
  await assert.rejects(
    platform.auth.loginApiKey("bad-api-key-provider", {
      prompt: async () => "code",
      notify: () => {},
    }),
    (error: unknown) => error instanceof ModelError && error.kind === "protocol",
  );
});

test("dynamic models restore offline and survive refresh failure", async () => {
  const modelStore = new InMemoryModelsStore();
  const authContext = defaultProviderAuthContext();
  const firstCredentials = new InMemoryCredentialStore();
  const firstModels = createModels({
    credentials: firstCredentials,
    modelsStore: modelStore,
    authContext,
  });
  firstModels.setProvider(dynamicRadiusProvider(false));
  const firstPlatform = new PiAiPlatform(firstModels, {
    credentials: firstCredentials,
    modelsStore: modelStore,
    authContext,
    excludedProviderIds: new Set(),
    verifiedProviderIds: new Set(),
  });
  await firstPlatform.auth.loginApiKey("radius", {
    prompt: async () => "radius-key",
    notify: () => {},
  });
  assert.equal(
    firstPlatform.catalog.getModel("radius", "radius-model")?.api,
    "pi-messages",
  );

  const secondCredentials = new InMemoryCredentialStore();
  await secondCredentials.modify("radius", async () => ({
    type: "api_key",
    key: "radius-key",
  }));
  const secondModels = createModels({
    credentials: secondCredentials,
    modelsStore: modelStore,
    authContext,
  });
  secondModels.setProvider(dynamicRadiusProvider(true));
  await secondModels.refresh({ allowNetwork: false });
  const secondPlatform = new PiAiPlatform(secondModels, {
    credentials: secondCredentials,
    modelsStore: modelStore,
    authContext,
    excludedProviderIds: new Set(),
    verifiedProviderIds: new Set(),
  });
  assert.equal(
    secondPlatform.catalog.getModel("radius", "radius-model")?.id,
    "radius-model",
  );
  await assert.rejects(
    secondPlatform.catalog.refresh("radius"),
    /refresh failed/,
  );
  assert.equal(
    secondPlatform.catalog.getModel("radius", "radius-model")?.id,
    "radius-model",
  );
});

test("catalog refresh only touches the requested dynamic provider", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("radius", async () => ({
    type: "api_key",
    key: "radius-key",
  }));
  await credentials.modify("openrouter", async () => ({
    type: "api_key",
    key: "openrouter-key",
  }));
  const modelStore = new InMemoryModelsStore();
  const authContext = defaultProviderAuthContext();
  const models = createModels({
    credentials,
    modelsStore: modelStore,
    authContext,
  });
  const calls = new Map<string, number>();
  models.setProvider(dynamicCountingProvider("radius", calls));
  models.setProvider(dynamicCountingProvider("openrouter", calls));
  const platform = new PiAiPlatform(models, {
    credentials,
    modelsStore: modelStore,
    authContext,
    excludedProviderIds: new Set(),
    verifiedProviderIds: new Set(),
  });

  await platform.catalog.refresh("radius");

  assert.equal(calls.get("radius"), 1);
  assert.equal(calls.get("openrouter") ?? 0, 0);
  assert.equal(platform.catalog.getModel("radius", "radius-model")?.id, "radius-model");
  assert.equal(platform.catalog.getModel("openrouter", "openrouter-model"), undefined);
});

function fakeProvider(
  id: string,
  options: { apiKey?: boolean; oauth?: boolean },
): Provider {
  const model: Model<"openai-completions"> = {
    id: `${id}-model`,
    name: `${id} Model`,
    api: "openai-completions",
    provider: id,
    baseUrl: `https://${id}.example/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
  };
  const apiKey = options.apiKey
    ? {
        name: `${id} API key`,
        login: async (): Promise<ApiKeyCredential> => ({
          type: "api_key",
          key: "test-key",
        }),
        resolve: async (): Promise<AuthResult | undefined> => undefined,
      }
    : undefined;
  const oauth = options.oauth
    ? {
        name: `${id} OAuth`,
        login: async (): Promise<OAuthCredential> => ({
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        }),
        refresh: async (credential: OAuthCredential) => credential,
        toAuth: async () => ({ apiKey: "oauth-key" }),
      }
    : undefined;
  const noEvents = async function* (): AsyncGenerator<AssistantMessageEvent> {};
  return {
    id,
    name: id,
    auth: { ...(apiKey === undefined ? {} : { apiKey }), ...(oauth === undefined ? {} : { oauth }) },
    getModels: () => [model],
    stream: noEvents,
    streamSimple: noEvents,
  };
}

function dynamicCountingProvider(
  id: string,
  calls: Map<string, number>,
): Provider {
  let current: Model<Api>[] = [];
  const model: Model<"pi-messages"> = {
    id: `${id}-model`,
    name: `${id} Model`,
    api: "pi-messages",
    provider: id,
    baseUrl: `https://${id}.example/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  const noEvents = async function* (): AsyncGenerator<AssistantMessageEvent> {};
  return {
    id,
    name: id,
    auth: {
      apiKey: {
        name: `${id} API key`,
        login: async () => ({ type: "api_key", key: `${id}-key` }),
        resolve: async ({ credential }) => credential?.key
          ? { auth: { apiKey: credential.key }, source: "stored credential" }
          : undefined,
      },
    },
    getModels: () => current,
    refreshModels: async (context) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (!context.allowNetwork) return;
      current = [model];
      await context.store.write({ models: current, checkedAt: 1234 });
    },
    stream: noEvents,
    streamSimple: noEvents,
  };
}

function dynamicRadiusProvider(failOnNetwork: boolean): Provider {
  let current: Model<Api>[] = [];
  const model: Model<"pi-messages"> = {
    id: "radius-model",
    name: "Radius Model",
    api: "pi-messages",
    provider: "radius",
    baseUrl: "https://radius.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
  const noEvents = async function* (): AsyncGenerator<AssistantMessageEvent> {};
  return {
    id: "radius",
    name: "Radius",
    auth: {
      apiKey: {
        name: "Radius API key",
        login: async () => ({ type: "api_key", key: "radius-key" }),
        resolve: async ({ credential }) => credential?.key
          ? { auth: { apiKey: credential.key }, source: "stored credential" }
          : undefined,
      },
    },
    getModels: () => current,
    refreshModels: async (context) => {
      const stored = await context.store.read();
      if (stored !== undefined) current = [...stored.models];
      if (!context.allowNetwork) return;
      if (failOnNetwork) throw new Error("refresh failed");
      current = [model];
      await context.store.write({ models: current, checkedAt: 1234 });
    },
    stream: noEvents,
    streamSimple: noEvents,
  };
}

function makePlatformWithProviders(providers: readonly Provider[]): ModelPlatform {
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const authContext = defaultProviderAuthContext();
  const models = createModels({ credentials, modelsStore, authContext });
  for (const provider of providers) models.setProvider(provider);
  return new PiAiPlatform(models, {
    credentials,
    modelsStore,
    authContext,
    excludedProviderIds: new Set(["amazon-bedrock", "google-vertex"]),
    verifiedProviderIds: new Set(),
  });
}

class MemoryCredentials implements ApiKeyCredentialStoreLike {
  readonly entries = new Map<string, ApiKeyCredential>();

  async read(providerId: string): Promise<ApiKeyCredential | undefined> {
    return this.entries.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.entries.keys()].sort().map((providerId) => ({
      providerId,
      type: "api_key" as const,
    }));
  }

  async modify(
    providerId: string,
    fn: (
      current: ApiKeyCredential | undefined,
    ) => Promise<ApiKeyCredential | undefined>,
  ): Promise<ApiKeyCredential | undefined> {
    const next = await fn(this.entries.get(providerId));
    if (next !== undefined) this.entries.set(providerId, next);
    return this.entries.get(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
}

class MemoryCatalogStore implements ModelCatalogStoreLike {
  async read(): Promise<StoredModelCatalogEntry | undefined> {
    return undefined;
  }
  async write(): Promise<void> {}
  async delete(): Promise<void> {}
}

class InMemoryCredentialStore {
  readonly entries = new Map<string, Credential>();

  async read(providerId: string): Promise<Credential | undefined> {
    return this.entries.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.entries].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await fn(this.entries.get(providerId));
    if (next !== undefined) this.entries.set(providerId, next);
    return this.entries.get(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.entries.delete(providerId);
  }
}

async function makeCloudflarePlatform(): Promise<{
  platform: ModelPlatform;
  credentials: MemoryCredentials;
}> {
  const credentials = new MemoryCredentials();
  const platform = await createPiAiPlatform({
    credentials,
    modelCatalogStore: new MemoryCatalogStore(),
    excludedProviderIds: new Set(["amazon-bedrock", "google-vertex"]),
    verifiedProviderIds: new Set(),
  });
  return { platform, credentials };
}
