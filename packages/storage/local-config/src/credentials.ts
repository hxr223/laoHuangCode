/** Private local storage for model provider API-key credentials. */

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

export interface ApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface CredentialInfo {
  readonly providerId: string;
  readonly type: "api_key";
}

interface CredentialsDocument {
  version: 1 | 2;
  providers: Record<string, ApiKeyCredential>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCredential(
  providerId: string,
  entry: unknown,
  version: number,
): ApiKeyCredential {
  if (!isPlainObject(entry)) {
    throw new Error("Credentials contain an invalid provider entry");
  }
  if (version === 1) {
    const apiKey = entry["api_key"];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new Error(`Credential for '${providerId}' has no API key`);
    }
    return { type: "api_key", key: apiKey };
  }
  const type = entry["type"];
  if (type === "oauth") {
    throw new Error("OAuth credentials are not supported");
  }
  if (type !== "api_key") {
    throw new Error(`Credential for '${providerId}' must be an API-key credential`);
  }
  const credential: {
    type: "api_key";
    key?: string;
    env?: Readonly<Record<string, string>>;
  } = { type: "api_key" };
  const key = entry["key"];
  if (key !== undefined) {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`Credential for '${providerId}' has an invalid API key`);
    }
    credential.key = key;
  }
  const env = entry["env"];
  if (env !== undefined) {
    if (!isPlainObject(env)) {
      throw new Error(`Credential for '${providerId}' provider environment must be an object`);
    }
    const normalizedEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (!name || typeof value !== "string" || value.length === 0) {
        throw new Error(
          `Credential for '${providerId}' provider environment has an invalid entry`,
        );
      }
      normalizedEnv[name] = value;
    }
    credential.env = normalizedEnv;
  }
  validateApiKeyCredential(credential);
  return credential;
}

function validateApiKeyCredential(credential: ApiKeyCredential): void {
  if (credential.type !== "api_key") {
    throw new Error("Only API-key credentials are supported");
  }
  const hasKey = typeof credential.key === "string" && credential.key.length > 0;
  const env = credential.env;
  const hasEnv = env !== undefined && Object.keys(env).length > 0;
  if (!hasKey && !hasEnv) {
    throw new Error("API-key credential must contain a key or provider environment");
  }
  if (credential.key !== undefined && !hasKey) {
    throw new Error("API key cannot be empty");
  }
  if (env !== undefined) {
    for (const [name, value] of Object.entries(env)) {
      if (!name || typeof value !== "string" || value.length === 0) {
        throw new Error("Provider environment values must be non-empty strings");
      }
    }
  }
}

/** Persist API keys separately from ordinary model configuration. */
export class CredentialStore {
  readonly path: string;
  #mutation: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async read(providerId: string): Promise<ApiKeyCredential | undefined> {
    return this.readDocument().providers[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.keys(this.readDocument().providers)
      .sort()
      .map((providerId) => ({ providerId, type: "api_key" as const }));
  }

  async modify(
    providerId: string,
    fn: (
      current: ApiKeyCredential | undefined,
    ) => Promise<ApiKeyCredential | undefined>,
  ): Promise<ApiKeyCredential | undefined> {
    if (!providerId) {
      throw new Error("Provider cannot be empty");
    }
    const operation = this.#mutation.then(async () => {
      const document = this.readDocument();
      const current = document.providers[providerId];
      const next = await fn(current);
      if (next !== undefined) {
        validateApiKeyCredential(next);
        document.providers[providerId] = normalizeStoredCredential(next);
        this.writeDocument({ version: 2, providers: document.providers });
      } else if (document.version !== 2) {
        this.writeDocument({ version: 2, providers: document.providers });
      }
      return document.providers[providerId];
    });
    this.#mutation = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }

  async delete(providerId: string): Promise<void> {
    if (!providerId) {
      throw new Error("Provider cannot be empty");
    }
    const operation = this.#mutation.then(async () => {
      const document = this.readDocument();
      if (providerId in document.providers) {
        delete document.providers[providerId];
        this.writeDocument({ version: 2, providers: document.providers });
      } else if (document.version !== 2) {
        this.writeDocument({ version: 2, providers: document.providers });
      }
    });
    this.#mutation = operation.then(
      () => {},
      () => {},
    );
    await operation;
  }

  private readDocument(): CredentialsDocument {
    if (!existsSync(this.path)) {
      return { version: 2, providers: {} };
    }
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read credentials: ${errorMessage(error)}`);
    }
    if (!isPlainObject(document)) {
      throw new Error("Credentials root must be a JSON object");
    }
    const version = document["version"] ?? 1;
    if (version !== 1 && version !== 2) {
      throw new Error(`Unsupported credentials version: ${String(version)}`);
    }
    const providers = document["providers"] ?? {};
    if (!isPlainObject(providers)) {
      throw new Error("Credentials providers must be an object");
    }
    const normalized: Record<string, ApiKeyCredential> = {};
    for (const [providerId, entry] of Object.entries(providers)) {
      if (!providerId) {
        throw new Error("Credential provider IDs must be non-empty strings");
      }
      normalized[providerId] = normalizeCredential(providerId, entry, version);
    }
    return { version, providers: normalized };
  }

  private writeDocument(document: CredentialsDocument): void {
    const parent = dirname(this.path);
    const parentExisted = existsSync(parent);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!parentExisted) {
      chmodSync(parent, 0o700);
    }
    const content = JSON.stringify({
      version: 2,
      providers: document.providers,
    }, null, 2) + "\n";
    const temporary = join(
      parent,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}

function normalizeStoredCredential(credential: ApiKeyCredential): ApiKeyCredential {
  return {
    type: "api_key",
    ...(credential.key === undefined ? {} : { key: credential.key }),
    ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
  };
}
