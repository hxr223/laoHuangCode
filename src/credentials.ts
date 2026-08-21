/** Private local storage for model provider credentials. */

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

import { providerNames } from "./providers.ts";

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(providerNames());

function requireKnownProvider(name: string): void {
  if (!KNOWN_PROVIDERS.has(name)) {
    throw new Error(`Unknown provider: ${name}`);
  }
}

interface StoredCredential {
  api_key: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Persist API keys separately from ordinary model configuration. */
export class CredentialStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  get(provider: string): string | null {
    const document = this.read();
    const providers = (document["providers"] ?? {}) as Record<
      string,
      StoredCredential
    >;
    const entry = providers[provider];
    return entry === undefined ? null : entry.api_key;
  }

  set(provider: string, apiKey: string): void {
    requireKnownProvider(provider);
    const key = apiKey.trim();
    if (!key) {
      throw new Error("API key cannot be empty");
    }
    const document = this.read();
    if (!("version" in document)) {
      document["version"] = 1;
    }
    const providers = (document["providers"] ??= {}) as Record<string, unknown>;
    providers[provider] = { api_key: key };
    this.write(document);
  }

  remove(provider: string): boolean {
    const document = this.read();
    const providers = (document["providers"] ?? {}) as Record<string, unknown>;
    if (!(provider in providers)) {
      return false;
    }
    delete providers[provider];
    this.write(document);
    return true;
  }

  providers(): string[] {
    const document = this.read();
    const providers = (document["providers"] ?? {}) as Record<string, unknown>;
    return Object.keys(providers).sort();
  }

  private read(): Record<string, unknown> {
    if (!existsSync(this.path)) {
      return {};
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
    const providers = document["providers"] ?? {};
    if (!isPlainObject(providers)) {
      throw new Error("Credentials providers must be an object");
    }
    for (const [provider, entry] of Object.entries(providers)) {
      if (!isPlainObject(entry)) {
        throw new Error("Credentials contain an invalid provider entry");
      }
      const apiKey = entry["api_key"];
      if (typeof apiKey !== "string" || !apiKey) {
        throw new Error(`Credential for '${provider}' has no API key`);
      }
    }
    return document;
  }

  private write(document: Record<string, unknown>): void {
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
