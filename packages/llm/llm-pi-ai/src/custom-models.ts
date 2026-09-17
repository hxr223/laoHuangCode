import {
  createProvider, envApiKeyAuth,
  type Api, type Model, type MutableModels, type Provider, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { Check } from "typebox/value";
import {
  anthropicCompat, completionsCompat, responsesCompat, customModelError, parseCustomModels,
  type CustomModel, type CustomProvider,
} from "./custom-model-schema.ts";

const streams: Partial<Record<Api, ProviderStreams>> = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
  "google-generative-ai": googleGenerativeAIApi(),
};

function validateUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { customModelError(`${label}: baseUrl must be an HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    customModelError(`${label}: baseUrl must use HTTP(S), without credentials, query or fragment`);
  }
}

function validateHeaders(headers: Record<string, string> | undefined, label: string): void {
  for (const name of Object.keys(headers ?? {})) {
    if (/^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(name)) {
      customModelError(`${label}: authentication headers belong in credentials, not model definitions`);
    }
  }
}

function resolveModel(id: string, config: CustomProvider, entry: CustomModel, base?: Model<Api>): Model<Api> {
  const label = `${id}/${entry.id}`;
  const api = entry.api ?? config.api ?? base?.api;
  const baseUrl = entry.baseUrl ?? config.baseUrl ?? base?.baseUrl;
  if (!api || !baseUrl) customModelError(`${label}: new models require api and baseUrl`);
  validateUrl(baseUrl, label);
  validateHeaders(entry.headers, label);
  const contextWindow = entry.contextWindow ?? base?.contextWindow;
  const maxTokens = entry.maxTokens ?? base?.maxTokens;
  if (contextWindow === undefined || maxTokens === undefined) {
    customModelError(`${label}: new models require contextWindow and maxTokens`);
  }
  if (maxTokens > contextWindow) customModelError(`${label}: maxTokens cannot exceed contextWindow`);
  const sameApi = base?.api === api;
  const mergedCompat = { ...(sameApi ? base?.compat : undefined), ...config.compat, ...entry.compat };
  // Validate user overrides against the selected protocol, not a permissive union.
  const userCompat = { ...config.compat, ...entry.compat };
  if (Object.keys(userCompat).length > 0) {
    const schema = api === "openai-completions" ? completionsCompat
      : api === "openai-responses" ? responsesCompat
        : api === "anthropic-messages" ? anthropicCompat : undefined;
    if (schema === undefined || !Check(schema, userCompat)) {
      customModelError(`${label}: invalid compat fields for ${api}`);
    }
  }
  const result: Model<Api> = {
    ...base,
    id: entry.id, provider: id, name: entry.name ?? base?.name ?? entry.id,
    api, baseUrl, reasoning: entry.reasoning ?? base?.reasoning ?? false,
    input: entry.input ?? base?.input ?? ["text"], contextWindow, maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...base?.cost, ...entry.cost },
    headers: { ...base?.headers, ...config.headers, ...entry.headers },
    thinkingLevelMap: { ...(sameApi ? base?.thinkingLevelMap : undefined), ...entry.thinkingLevelMap },
    samplingParams: { ...base?.samplingParams, ...entry.samplingParams },
  };
  // The schema is protocol-checked above; SDK metadata remains owned by the SDK.
  result.compat = mergedCompat;
  return result;
}

function customProvider(id: string, config: CustomProvider, base?: Provider): Provider {
  validateHeaders(config.headers, id);
  if (config.baseUrl !== undefined) validateUrl(config.baseUrl, id);
  const entries = new Map<string, CustomModel>();
  for (const entry of config.models ?? []) {
    if (entries.has(entry.id)) customModelError(`${id}: duplicate model ID ${entry.id}`);
    entries.set(entry.id, entry);
  }
  const baseline = new Map(base?.getModels().map(model => [model.id, model]));
  const additions = new Map<string, Model<Api>>();
  for (const [modelId, entry] of entries) {
    // New models can inherit a provider endpoint, but never guess its protocol.
    additions.set(modelId, resolveModel(id, { ...config, baseUrl: config.baseUrl ?? base?.baseUrl }, entry, baseline.get(modelId)));
  }
  const getModels = (): Model<Api>[] => {
    const result = new Map<string, Model<Api>>();
    for (const model of base?.getModels() ?? []) {
      result.set(model.id, resolveModel(id, config, entries.get(model.id) ?? { id: model.id }, model));
    }
    for (const [modelId, model] of additions) if (!result.has(modelId)) result.set(modelId, model);
    return [...result.values()];
  };
  if (getModels().length === 0 && !base) customModelError(`${id}: provider must define at least one model`);
  const auth = config.apiKeyEnv !== undefined || base === undefined
    ? { apiKey: envApiKeyAuth(`${config.name ?? id} API key`, config.apiKeyEnv ? [config.apiKeyEnv] : []) }
    : base.auth;
  const transport = createProvider({ id, auth, models: [], api: streams });
  const dispatch = (model: Model<Api>): Provider => {
    const configured = entries.get(model.id);
    return base && config.api === undefined && configured?.api === undefined
      ? base : transport;
  };
  return {
    ...base,
    id, name: config.name ?? base?.name ?? id, auth,
    baseUrl: config.baseUrl ?? base?.baseUrl,
    headers: { ...base?.headers, ...config.headers },
    getModels,
    // Keep provider-owned refresh/cache logic; getModels reapplies user overrides afterwards.
    ...(base?.filterModels === undefined ? {} : {
      filterModels: (models, credential) => {
        const available = new Set(base.filterModels!(models, credential).map(model => model.id));
        return models.filter(model => available.has(model.id) || additions.has(model.id));
      },
    }),
    stream: (model, context, options) => dispatch(model).stream(model, context, options),
    streamSimple: (model, context, options) => dispatch(model).streamSimple(model, context, options),
  };
}

/** Publishes a complete, validated overlay in one synchronous transaction. */
export class CustomModelRegistry {
  private readonly models: MutableModels;
  private readonly baseline: ReadonlyMap<string, Provider>;
  private readonly excluded: ReadonlySet<string>;
  private readonly read: () => Promise<unknown>;
  private applied = new Set<string>();
  private revision: string | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(models: MutableModels, excluded: ReadonlySet<string>, read: () => Promise<unknown>) {
    this.models = models;
    this.baseline = new Map(models.getProviders().map(provider => [provider.id, provider]));
    this.excluded = excluded;
    this.read = read;
  }

  get providerIds(): ReadonlySet<string> { return this.applied; }

  reload(): Promise<void> {
    const next = this.pending.catch(() => {}).then(async () => {
      const config = parseCustomModels(await this.read());
      const revision = JSON.stringify(config);
      if (revision === this.revision) return;
      const providers: Provider[] = [];
      for (const [id, definition] of Object.entries(config.providers)) {
        const base = this.baseline.get(id);
        if (this.excluded.has(id) || (base && !base.auth.apiKey?.login)) {
          customModelError(`${id}: this provider is excluded or requires unsupported authentication`);
        }
        providers.push(customProvider(id, definition, base));
      }
      // Nothing is mutated before every definition has passed validation.
      for (const id of this.applied) {
        const base = this.baseline.get(id);
        if (base) this.models.setProvider(base);
        else this.models.deleteProvider(id);
      }
      for (const provider of providers) this.models.setProvider(provider);
      this.applied = new Set(providers.map(provider => provider.id));
      this.revision = revision;
    });
    this.pending = next;
    return next;
  }
}
