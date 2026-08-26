/** Private local storage for dynamic model catalogs restored from pi-ai. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface StoredModelCatalogEntry {
  readonly models: readonly Record<string, unknown>[];
  readonly lastModified?: number;
  readonly checkedAt?: number;
  readonly etag?: string;
}

interface ModelCatalogDocument {
  readonly version: 1;
  readonly providers: Record<string, StoredModelCatalogEntry>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ModelCatalogStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(providerId: string): Promise<StoredModelCatalogEntry | undefined> {
    return this.readDocument().providers[providerId];
  }

  async write(providerId: string, entry: StoredModelCatalogEntry): Promise<void> {
    if (!providerId) {
      throw new Error("Provider cannot be empty");
    }
    const document = this.readDocument();
    document.providers[providerId] = normalizeEntry(providerId, entry);
    this.writeDocument(document);
  }

  async delete(providerId: string): Promise<void> {
    const document = this.readDocument();
    if (providerId in document.providers) {
      delete document.providers[providerId];
      this.writeDocument(document);
    }
  }

  private readDocument(): ModelCatalogDocument {
    if (!existsSync(this.path)) {
      return { version: 1, providers: {} };
    }
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read model catalog: ${errorMessage(error)}`);
    }
    if (!isPlainObject(document)) {
      throw new Error("Model catalog root must be a JSON object");
    }
    if ((document["version"] ?? 1) !== 1) {
      throw new Error(`Unsupported model catalog version: ${String(document["version"])}`);
    }
    const providers = document["providers"] ?? {};
    if (!isPlainObject(providers)) {
      throw new Error("Model catalog providers must be an object");
    }
    const normalized: Record<string, StoredModelCatalogEntry> = {};
    for (const [providerId, entry] of Object.entries(providers)) {
      normalized[providerId] = normalizeEntry(providerId, entry);
    }
    return { version: 1, providers: normalized };
  }

  private writeDocument(document: ModelCatalogDocument): void {
    const parent = dirname(this.path);
    const parentExisted = existsSync(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!parentExisted) {
      chmodSync(parent, 0o700);
    }
    const content = JSON.stringify(document, null, 2) + "\n";
    const temporary = join(
      parent,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}

function normalizeEntry(
  providerId: string,
  entry: unknown,
): StoredModelCatalogEntry {
  if (!isPlainObject(entry)) {
    throw new Error(`Model catalog entry for '${providerId}' must be an object`);
  }
  const models = entry["models"];
  if (!Array.isArray(models)) {
    throw new Error(`Model catalog entry for '${providerId}' needs models`);
  }
  const normalizedModels: Record<string, unknown>[] = [];
  for (const model of models) {
    if (!isPlainObject(model)) {
      throw new Error(`Model catalog entry for '${providerId}' has an invalid model`);
    }
    normalizedModels.push({ ...model });
  }
  const normalized: {
    models: readonly Record<string, unknown>[];
    lastModified?: number;
    checkedAt?: number;
    etag?: string;
  } = { models: normalizedModels };
  for (const key of ["lastModified", "checkedAt"] as const) {
    const value = entry[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Model catalog '${key}' for '${providerId}' must be finite`);
      }
      normalized[key] = value;
    }
  }
  const etag = entry["etag"];
  if (etag !== undefined) {
    if (typeof etag !== "string" || etag.length === 0) {
      throw new Error(`Model catalog etag for '${providerId}' must be non-empty`);
    }
    normalized.etag = etag;
  }
  return normalized;
}
