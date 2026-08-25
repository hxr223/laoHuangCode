/** Persistent model profiles and runtime configuration. */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { CredentialStore } from "./credentials.ts";

/** Runtime configuration resolved from a stored profile. */
export interface Config {
  readonly model: string;
  readonly baseUrl: string | null;
  readonly provider: string;
  readonly profile: string | null;
  readonly apiKey: string | null;
}

/** One entry of {@link ConfigManager.listProfiles}. */
export interface ProfileSummary {
  readonly name: string;
  readonly active: boolean;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string | null;
}

export interface ConfigureOptions {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string | null;
}

export interface ResolveSettingsOptions {
  environ?: Record<string, string | undefined>;
  profile?: string | null;
  model?: string | null;
  baseUrl?: string | null;
}

export interface ResolveOptions extends ResolveSettingsOptions {
  credentials: Pick<CredentialStore, "get">;
}

/** Profile as stored inside the JSON document (schema is snake_case). */
interface StoredProfile {
  provider: string;
  model: string;
  base_url: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandUser(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/**
 * Default location of the configuration file:
 * `$LAOHUANG_CONFIG`, else `$XDG_CONFIG_HOME/laohuang/config.json`,
 * else `~/.config/laohuang/config.json`.
 */
export function defaultConfigPath(
  environ: Record<string, string | undefined> = process.env,
): string {
  const explicit = environ["LAOHUANG_CONFIG"];
  if (explicit) {
    return expandUser(explicit);
  }
  const configHome = environ["XDG_CONFIG_HOME"];
  const root = configHome ? expandUser(configHome) : join(homedir(), ".config");
  return join(root, "laohuang", "config.json");
}

/** Persist model profiles and resolve one into runtime configuration. */
export class ConfigManager {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  configure(options: ConfigureOptions): void {
    if (!options.provider) {
      throw new Error("A provider is required");
    }
    if (!options.model) {
      throw new Error(`A model is required for provider: ${options.provider}`);
    }
    const document = this.readDocument({ optional: true });
    if (!("version" in document)) {
      document["version"] = 1;
    }
    const profiles = (document["profiles"] ??= {}) as Record<string, unknown>;
    profiles[options.name] = {
      provider: options.provider,
      model: options.model,
      base_url: options.baseUrl,
    } satisfies StoredProfile;
    document["active_profile"] = options.name;
    this.writeDocument(document);
  }

  resolve(options: ResolveOptions): Config {
    const config = this.resolveSettings(options);
    const apiKey = options.credentials.get(config.provider);
    if (!apiKey) {
      throw new Error(`No API key configured for provider: ${config.provider}`);
    }
    return { ...config, apiKey };
  }

  resolveSettings(options: ResolveSettingsOptions = {}): Config {
    const document = this.readDocument();
    const environment = options.environ ?? process.env;
    const profileName =
      options.profile ||
      environment["LAOHUANG_PROFILE"] ||
      (document["active_profile"] as string | null | undefined);
    const profiles = (document["profiles"] ?? {}) as Record<
      string,
      StoredProfile
    >;
    if (!profileName || !(profileName in profiles)) {
      throw new Error("No configured model profile");
    }
    const stored = profiles[profileName]!;
    const providerName = stored.provider;
    const resolvedModel =
      options.model || environment["LAOHUANG_MODEL"] || stored.model;
    const resolvedBaseUrl =
      options.baseUrl ?? environment["LAOHUANG_BASE_URL"] ?? stored.base_url;
    return {
      model: resolvedModel,
      baseUrl: resolvedBaseUrl,
      provider: providerName,
      profile: profileName,
      apiKey: null,
    };
  }

  setActive(name: string): void {
    const document = this.readDocument();
    const profiles = (document["profiles"] ?? {}) as Record<string, unknown>;
    if (!(name in profiles)) {
      throw new Error(`Unknown profile: ${name}`);
    }
    document["active_profile"] = name;
    this.writeDocument(document);
  }

  listProfiles(): ProfileSummary[] {
    const document = this.readDocument();
    const active = document["active_profile"] as string | null | undefined;
    const profiles = (document["profiles"] ?? {}) as Record<
      string,
      StoredProfile
    >;
    return Object.keys(profiles)
      .sort()
      .map((name) => {
        const profile = profiles[name]!;
        return {
          name,
          active: name === active,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.base_url,
        };
      });
  }

  private readDocument(options: { optional?: boolean } = {}): Record<
    string,
    unknown
  > {
    if (!existsSync(this.path)) {
      if (options.optional) {
        return {};
      }
      throw new Error(`Configuration file not found: ${this.path}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read configuration: ${errorMessage(error)}`);
    }
    if (!isPlainObject(value)) {
      throw new Error("Configuration root must be a JSON object");
    }
    validateDocument(value);
    return value;
  }

  private writeDocument(document: Record<string, unknown>): void {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
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

function validateDocument(document: Record<string, unknown>): void {
  const version = document["version"] ?? 1;
  if (version !== 1) {
    throw new Error(`Unsupported configuration version: ${String(version)}`);
  }

  const active = document["active_profile"];
  if (active !== undefined && active !== null && typeof active !== "string") {
    throw new Error("Configuration active_profile must be a string");
  }

  const profiles = document["profiles"] ?? {};
  if (!isPlainObject(profiles)) {
    throw new Error("Configuration profiles must be an object");
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!name) {
      throw new Error("Configuration profile names must be non-empty strings");
    }
    if (!isPlainObject(profile)) {
      throw new Error(`Configuration profile '${name}' must be an object`);
    }
    const provider = profile["provider"];
    const model = profile["model"];
    const baseUrl = profile["base_url"];
    if (typeof provider !== "string" || !provider) {
      throw new Error(`Configuration profile '${name}' needs a provider`);
    }
    if (typeof model !== "string" || !model) {
      throw new Error(`Configuration profile '${name}' needs a model`);
    }
    if (baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== "string") {
      throw new Error(`Configuration profile '${name}' base_url must be a string`);
    }
  }
}
