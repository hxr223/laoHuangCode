import { ModelError } from "@laohuang/llm";
import type {
  Api,
  Model as PiModel,
  ModelsStore,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";

export interface StoredModelCatalogEntry {
  readonly models: readonly Record<string, unknown>[];
  readonly lastModified?: number;
  readonly checkedAt?: number;
  readonly etag?: string;
}

export interface ModelCatalogStoreLike {
  read(providerId: string): Promise<StoredModelCatalogEntry | undefined>;
  write(providerId: string, entry: StoredModelCatalogEntry): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export class PiModelsStore implements ModelsStore {
  private readonly store: ModelCatalogStoreLike;

  constructor(store: ModelCatalogStoreLike) {
    this.store = store;
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = await this.store.read(providerId);
    if (entry === undefined) {
      return undefined;
    }
    return {
      models: entry.models.map((model) => restoreModel(providerId, model)),
      ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
      ...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }),
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
    };
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.store.write(providerId, {
      models: entry.models.map((model) => ({ ...model })),
      ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
      ...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }),
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.store.delete(providerId);
  }
}

function restoreModel(providerId: string, model: Record<string, unknown>): PiModel<Api> {
  const id = readString(model, "id", providerId);
  const name = readString(model, "name", providerId);
  const api = readString(model, "api", providerId) as Api;
  const provider = readString(model, "provider", providerId);
  const input = model["input"];
  if (!Array.isArray(input) || !input.every((item) => typeof item === "string")) {
    throw new ModelError(`stored model for '${providerId}' has invalid input`, {
      kind: "protocol",
    });
  }
  const cost = model["cost"];
  if (!isCost(cost)) {
    throw new ModelError(`stored model for '${providerId}' has invalid cost`, {
      kind: "protocol",
    });
  }
  const reasoning = model["reasoning"];
  if (typeof reasoning !== "boolean") {
    throw new ModelError(`stored model for '${providerId}' has invalid reasoning`, {
      kind: "protocol",
    });
  }
  return {
    ...model,
    id,
    name,
    api,
    provider,
    reasoning,
    input,
    cost,
    contextWindow: readPositiveNumber(model, "contextWindow", providerId),
    maxTokens: readPositiveNumber(model, "maxTokens", providerId),
  } as PiModel<Api>;
}

function readString(
  model: Record<string, unknown>,
  field: string,
  providerId: string,
): string {
  const value = model[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelError(`stored model for '${providerId}' has invalid ${field}`, {
      kind: "protocol",
    });
  }
  return value;
}

function readPositiveNumber(
  model: Record<string, unknown>,
  field: string,
  providerId: string,
): number {
  const value = model[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ModelError(`stored model for '${providerId}' has invalid ${field}`, {
      kind: "protocol",
    });
  }
  return value;
}

function isCost(value: unknown): value is PiModel<Api>["cost"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every((field) => {
    const item = record[field];
    return typeof item === "number" && Number.isFinite(item);
  });
}
