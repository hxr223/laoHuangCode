import {
  ModelError,
  type ApiKeySetupInteraction,
  type ApiKeySetupPrompt,
  type ModelAuthService,
  type ModelAuthStatus,
  type ModelCatalog,
  type ModelInfo,
  type ModelPlatform,
  type ModelProviderInfo,
  type ReasoningEffort,
} from "@laohuang/llm";
import {
  defaultProviderAuthContext,
  getSupportedThinkingLevels,
  ModelsError,
  type Api,
  type AuthContext,
  type AuthEvent,
  type AuthPrompt,
  type Credential,
  type CredentialStore,
  type Model as PiModel,
  type Models,
  type ModelsStore,
  type ModelThinkingLevel,
  type ProviderModelsStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PiAiAdapter, piModelErrorKind } from "./adapter.ts";
import {
  PiCredentialStore,
  type ApiKeyCredentialStoreLike,
} from "./credential-bridge.ts";
import {
  PiModelsStore,
  type ModelCatalogStoreLike,
} from "./models-store-bridge.ts";

export interface PiAiPlatformOptions {
  readonly credentials: ApiKeyCredentialStoreLike;
  readonly modelCatalogStore: ModelCatalogStoreLike;
  readonly excludedProviderIds: ReadonlySet<string>;
  readonly verifiedProviderIds?: ReadonlySet<string>;
}

export async function createPiAiPlatform(
  options: PiAiPlatformOptions,
): Promise<ModelPlatform> {
  const credentials = new PiCredentialStore(options.credentials);
  const modelsStore = new PiModelsStore(options.modelCatalogStore);
  const authContext = defaultProviderAuthContext();
  const models = builtinModels({
    credentials,
    modelsStore,
    authContext,
  });
  await models.refresh({ allowNetwork: false });
  return new PiAiPlatform(models, {
    credentials,
    modelsStore,
    authContext,
    excludedProviderIds: options.excludedProviderIds,
    verifiedProviderIds: options.verifiedProviderIds ?? new Set(),
  });
}

export function eligibleProviderIds(
  models: Pick<Models, "getProviders">,
  excludedProviderIds: ReadonlySet<string>,
): string[] {
  return models
    .getProviders()
    .filter((provider) => isEligibleProvider(provider, excludedProviderIds))
    .map((provider) => provider.id)
    .sort();
}

export class PiAiPlatform implements ModelPlatform {
  readonly adapter: PiAiAdapter;
  readonly catalog: ModelCatalog;
  readonly auth: ModelAuthService;
  private readonly models: Models;
  private readonly eligibleIds: ReadonlySet<string>;
  private readonly verifiedProviderIds: ReadonlySet<string>;

  constructor(
    models: Models,
    options: {
      readonly credentials: CredentialStore;
      readonly modelsStore: ModelsStore;
      readonly authContext: AuthContext;
      readonly excludedProviderIds: ReadonlySet<string>;
      readonly verifiedProviderIds: ReadonlySet<string>;
    },
  ) {
    this.models = models;
    this.eligibleIds = new Set(eligibleProviderIds(models, options.excludedProviderIds));
    this.verifiedProviderIds = options.verifiedProviderIds;
    this.adapter = new PiAiAdapter({ eligibleProviderIds: this.eligibleIds }, models);
    this.catalog = new PiAiCatalog(
      this.models,
      this.eligibleIds,
      this.verifiedProviderIds,
      options.credentials,
      options.modelsStore,
      options.authContext,
    );
    this.auth = new PiAiAuthService(this.models, this.eligibleIds, this.catalog);
  }
}

function isEligibleProvider(
  provider: Provider,
  excludedProviderIds: ReadonlySet<string>,
): boolean {
  return provider.auth.apiKey?.login !== undefined &&
    !excludedProviderIds.has(provider.id);
}

class PiAiCatalog implements ModelCatalog {
  private readonly models: Models;
  private readonly eligibleIds: ReadonlySet<string>;
  private readonly verifiedProviderIds: ReadonlySet<string>;
  private readonly credentials: CredentialStore;
  private readonly modelsStore: ModelsStore;
  private readonly authContext: AuthContext;

  constructor(
    models: Models,
    eligibleIds: ReadonlySet<string>,
    verifiedProviderIds: ReadonlySet<string>,
    credentials: CredentialStore,
    modelsStore: ModelsStore,
    authContext: AuthContext,
  ) {
    this.models = models;
    this.eligibleIds = eligibleIds;
    this.verifiedProviderIds = verifiedProviderIds;
    this.credentials = credentials;
    this.modelsStore = modelsStore;
    this.authContext = authContext;
  }

  listProviders(): readonly ModelProviderInfo[] {
    return [...this.eligibleIds].map((id) => this.providerInfo(id));
  }

  getProvider(provider: string): ModelProviderInfo | undefined {
    if (!this.eligibleIds.has(provider)) {
      return undefined;
    }
    return this.providerInfo(provider);
  }

  listModels(provider: string): readonly ModelInfo[] {
    if (!this.eligibleIds.has(provider)) {
      return [];
    }
    return this.models.getModels(provider).map(modelInfo);
  }

  async listAvailableModels(provider: string): Promise<readonly ModelInfo[]> {
    if (!this.eligibleIds.has(provider)) {
      return [];
    }
    try {
      return (await this.models.getAvailable(provider)).map(modelInfo);
    } catch (error) {
      throw normalizePiError(error);
    }
  }

  getModel(provider: string, model: string): ModelInfo | undefined {
    if (!this.eligibleIds.has(provider)) {
      return undefined;
    }
    const found = this.models.getModel(provider, model);
    return found === undefined ? undefined : modelInfo(found);
  }

  async refresh(provider: string, signal?: AbortSignal): Promise<void> {
    if (!this.eligibleIds.has(provider)) {
      throw new ModelError(`Unknown provider: ${provider}`, { kind: "protocol" });
    }
    await this.refreshProvider(provider, signal);
  }

  private providerInfo(providerId: string): ModelProviderInfo {
    const provider = this.models.getProvider(providerId);
    if (provider === undefined || provider.auth.apiKey === undefined) {
      throw new ModelError(`Unknown provider: ${providerId}`, { kind: "protocol" });
    }
    return {
      id: provider.id,
      name: provider.name,
      authName: provider.auth.apiKey.name,
      dynamicModels: provider.refreshModels !== undefined,
      verified: this.verifiedProviderIds.has(provider.id),
    };
  }

  private async refreshProvider(
    providerId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const provider = this.models.getProvider(providerId);
    if (provider === undefined || provider.refreshModels === undefined) {
      return;
    }
    const stored = await this.readCredential(providerId);
    const credential = await this.resolveRefreshCredential(provider, stored, signal);
    if (credential === undefined) {
      return;
    }
    try {
      await provider.refreshModels({
        credential,
        store: this.providerStore(providerId),
        allowNetwork: true,
        force: true,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      try {
        await provider.refreshModels({
          credential: stored,
          store: this.providerStore(providerId),
          allowNetwork: false,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        // Preserve the original refresh error.
      }
      throw error;
    }
  }

  private async readCredential(providerId: string): Promise<Credential | undefined> {
    try {
      return await this.credentials.read(providerId);
    } catch (error) {
      throw new ModelsError("auth", `Credential store read failed for ${providerId}`, {
        cause: error,
      });
    }
  }

  private async resolveRefreshCredential(
    provider: Provider,
    stored: Credential | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Credential | undefined> {
    if (signal?.aborted) {
      return undefined;
    }
    if (stored?.type === "api_key" || stored === undefined) {
      const apiKey = provider.auth.apiKey;
      if (apiKey === undefined) {
        return undefined;
      }
      const result = await apiKey.resolve({
        ctx: this.authContext,
        credential: stored?.type === "api_key" ? stored : undefined,
      });
      return result === undefined
        ? undefined
        : { type: "api_key", key: result.auth.apiKey, env: result.env };
    }
    throw new ModelError("OAuth credentials are not supported", {
      kind: "protocol",
    });
  }

  private providerStore(providerId: string): ProviderModelsStore {
    return {
      read: () => this.modelsStore.read(providerId),
      write: (entry) => this.modelsStore.write(providerId, entry),
      delete: () => this.modelsStore.delete(providerId),
    };
  }
}

class PiAiAuthService implements ModelAuthService {
  private readonly models: Models;
  private readonly eligibleIds: ReadonlySet<string>;
  private readonly catalog: ModelCatalog;

  constructor(
    models: Models,
    eligibleIds: ReadonlySet<string>,
    catalog: ModelCatalog,
  ) {
    this.models = models;
    this.eligibleIds = eligibleIds;
    this.catalog = catalog;
  }

  async status(provider: string): Promise<ModelAuthStatus> {
    if (!this.eligibleIds.has(provider)) {
      return { configured: false };
    }
    try {
      const check = await this.models.checkAuth(provider);
      if (check === undefined || check.type !== "api_key") {
        return { configured: false };
      }
      return { configured: true, source: check.source ?? "stored credential" };
    } catch (error) {
      throw normalizePiError(error);
    }
  }

  async loginApiKey(
    provider: string,
    interaction: ApiKeySetupInteraction,
  ): Promise<ModelAuthStatus> {
    if (!this.eligibleIds.has(provider)) {
      throw new ModelError(`Unknown provider: ${provider}`, { kind: "protocol" });
    }
    try {
      const credential = await this.models.login(
        provider,
        "api_key",
        bridgeInteraction(interaction),
      );
      if (credential.type !== "api_key") {
        throw new ModelError("OAuth credentials are not supported", {
          kind: "protocol",
        });
      }
      const info = this.catalog.getProvider(provider);
      if (info?.dynamicModels) {
        await this.catalog.refresh(provider);
      }
      return await this.status(provider);
    } catch (error) {
      throw normalizePiError(error);
    }
  }

  async logout(provider: string): Promise<void> {
    if (!this.eligibleIds.has(provider)) {
      throw new ModelError(`Unknown provider: ${provider}`, { kind: "protocol" });
    }
    try {
      await this.models.logout(provider);
    } catch (error) {
      throw normalizePiError(error);
    }
  }
}

function bridgeInteraction(interaction: ApiKeySetupInteraction) {
  return {
    prompt: (prompt: AuthPrompt) => {
      if (
        prompt.type !== "text" &&
        prompt.type !== "secret" &&
        prompt.type !== "select"
      ) {
        throw new ModelError("OAuth setup prompts are not supported", {
          kind: "protocol",
        });
      }
      return interaction.prompt(prompt satisfies ApiKeySetupPrompt);
    },
    notify: (event: AuthEvent) => {
      if (event.type === "auth_url" || event.type === "device_code") {
        throw new ModelError("OAuth setup events are not supported", {
          kind: "protocol",
        });
      }
      interaction.notify(event.message);
    },
  };
}

function modelInfo(model: PiModel<Api>): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    supportedReasoningEfforts: getSupportedThinkingLevels(model).map(toReasoningEffort),
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function toReasoningEffort(level: ModelThinkingLevel): ReasoningEffort {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
  }
}

function normalizePiError(error: unknown): unknown {
  if (error instanceof ModelError) {
    return error;
  }
  return new ModelError(errorMessage(error), {
    kind: piModelErrorKind(error),
    cause: error,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
