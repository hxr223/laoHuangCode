import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { OAuthClientProvider, OAuthClientInformationContext, OAuthClientMetadata, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { isRecord } from "../config.ts";
import type { McpCredentialStore, McpOAuthConfig } from "../types.ts";

interface CredentialRecord {
  tokens?: StoredOAuthTokens;
  client?: StoredOAuthClientInformation;
}
export interface McpOAuthProviderOptions {
  identity: string; store: McpCredentialStore; config: McpOAuthConfig;
  env: Readonly<Record<string, string | undefined>>;
}

/** One source/resource identity, with separate issuer-bound credential records. */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly options: McpOAuthProviderOptions;
  private readonly ready: Promise<void>;
  private readonly issuers = new Set<string>();
  private issuer: string | undefined;
  private tail = Promise.resolve();
  private refreshTail = Promise.resolve();
  private active = true;
  private redirect = new URL("http://127.0.0.1:3118/callback");
  private verifier: string | undefined;
  private oauthState = randomBytes(32).toString("hex");
  private showUrl: ((url: string) => void) | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private readonly retiredAccessTokens = new Set<string>();
  private readonly requestAuth = new AsyncLocalStorage<{ accessToken: string | undefined }>();

  constructor(options: McpOAuthProviderOptions) {
    this.options = options;
    this.ready = options.store.read(`${options.identity}:index`).then(value => {
      if (!isRecord(value)) return;
      if (Array.isArray(value.issuers)) for (const issuer of value.issuers) if (typeof issuer === "string") this.issuers.add(issuer);
      if (typeof value.current === "string" && this.issuers.has(value.current)) this.issuer = value.current;
    });
    void this.ready.catch(() => {});
  }

  get redirectUrl(): URL { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "laohuang", redirect_uris: [this.redirect.toString()],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: this.options.config.clientSecretEnv ? "client_secret_post" : "none",
      ...(this.options.config.scopes ? { scope: this.options.config.scopes.join(" ") } : {}) };
  }
  state(): string { return this.oauthState; }
  saveCodeVerifier(value: string): void { this.assertActive(); this.verifier = value; }
  codeVerifier(): string { if (!this.verifier) throw new Error("MCP OAuth verifier is unavailable"); return this.verifier; }
  redirectToAuthorization(url: URL): void {
    this.assertActive();
    if (!this.showUrl) {
      const error = new Error("MCP authorization required; use /mcp login");
      error.name = "UnauthorizedError";
      throw error;
    }
    this.showUrl(url.toString());
  }
  beginLogin(redirect: URL, showUrl: (url: string) => void): void {
    this.assertActive(); this.redirect = redirect; this.showUrl = showUrl;
  }
  endLogin(): void { this.showUrl = undefined; this.verifier = undefined; this.oauthState = randomBytes(32).toString("hex"); }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    await this.ready;
    this.assertActive();
    if (this.options.config.clientId !== undefined) {
      const envName = this.options.config.clientSecretEnv;
      const secret = envName === undefined ? undefined : this.options.env[envName];
      if (envName !== undefined && !secret) throw new Error(`MCP environment variable is missing: ${envName}`);
      return { client_id: this.options.config.clientId, ...(ctx ? { issuer: ctx.issuer } : {}), ...(secret === undefined ? {} : { client_secret: secret }) };
    }
    const record = await this.read(ctx);
    if (this.showUrl && record.client && "redirect_uris" in record.client && !record.client.redirect_uris.includes(this.redirect.toString())) return undefined;
    return record.client;
  }
  saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    return this.update(ctx ?? (value.issuer ? { issuer: value.issuer } : undefined), record => { record.client = validateClient(value); });
  }
  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> { return (await this.read(ctx)).tokens; }
  saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    if (this.retiredAccessTokens.has(value.access_token)) return Promise.resolve();
    return this.update(ctx ?? (value.issuer ? { issuer: value.issuer } : undefined), record => {
      const tokens = validateTokens(value);
      if (!tokens.refresh_token && record.tokens?.refresh_token) tokens.refresh_token = record.tokens.refresh_token;
      record.tokens = tokens;
    });
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
  saveDiscoveryState(value: OAuthDiscoveryState): void { this.assertActive(); this.discovery = structuredClone(value); }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") { this.verifier = undefined; return Promise.resolve(); }
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
    if (scope === "discovery") return Promise.resolve();
    return this.update(undefined, record => {
      if (scope === "all" || scope === "tokens") delete record.tokens;
      if (scope === "all" || scope === "client") delete record.client;
    });
  }
  async logout(): Promise<void> {
    this.active = false;
    this.endLogin();
    await this.ready;
    await this.tail;
    for (const issuer of this.issuers) await this.options.store.remove(this.key(issuer));
    await this.options.store.remove(`${this.options.identity}:index`);
  }
  dispose(): void { this.active = false; this.endLogin(); }

  /** Preserve the credential generation of a logical SDK send across its 401 flow. */
  async withAuthContext<T>(work: () => Promise<T>): Promise<T> {
    if (this.requestAuth.getStore()) return work();
    const tokens = await this.tokens();
    return this.requestAuth.run({ accessToken: tokens?.access_token }, work);
  }

  /** Persist a refreshed token before releasing the per-provider network queue. */
  readonly fetch: typeof fetch = async (input, init) => {
    const body = init?.body ?? (input instanceof Request && input.headers.get("content-type")?.includes("application/x-www-form-urlencoded") ? await input.clone().text() : undefined);
    const params = body instanceof URLSearchParams ? body : typeof body === "string" ? new URLSearchParams(body) : undefined;
    if (params?.get("grant_type") !== "refresh_token") return fetch(input, init);
    const before = await this.tokens();
    const original = this.requestAuth.getStore()?.accessToken ?? before?.access_token;
    const work = this.refreshTail.then(async () => {
      this.assertActive();
      const current = await this.tokens();
      const requested = params.get("refresh_token");
      if (current && (current.access_token !== original || current.refresh_token && current.refresh_token !== requested)) {
        return new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } });
      }
      const response = await fetch(input, init);
      if (response.ok) {
        const value: unknown = await response.clone().json();
        const tokens = validateTokens(value);
        if (tokens.refresh_token === undefined && current?.refresh_token) tokens.refresh_token = current.refresh_token;
        if (current && current.access_token !== tokens.access_token) this.retiredAccessTokens.add(current.access_token);
        await this.saveTokens(tokens);
      }
      return response;
    });
    this.refreshTail = work.then(() => {}, () => {});
    return work;
  };

  private assertActive(): void { if (!this.active) throw new Error("MCP OAuth credentials are no longer active"); }
  private key(issuer: string): string { return JSON.stringify([this.options.identity, issuer]); }
  private async read(ctx?: OAuthClientInformationContext): Promise<CredentialRecord> {
    await this.ready; await this.tail; this.assertActive();
    if (ctx) this.issuer = ctx.issuer;
    return this.readRecord(this.issuer ?? "");
  }
  private async readRecord(issuer: string): Promise<CredentialRecord> {
    const value = await this.options.store.read(this.key(issuer));
    if (value === undefined) return {};
    if (!isRecord(value)) throw new Error("Invalid stored MCP OAuth credentials");
    const record: CredentialRecord = {};
    if (value.tokens !== undefined) record.tokens = validateTokens(value.tokens);
    if (value.client !== undefined) record.client = validateClient(value.client);
    return record;
  }
  private update(ctx: OAuthClientInformationContext | undefined, change: (record: CredentialRecord) => void): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.ready; this.assertActive();
      const issuer = ctx?.issuer ?? this.issuer ?? "";
      const record = await this.readRecord(issuer);
      this.assertActive(); change(record);
      await this.options.store.write(this.key(issuer), record);
      this.issuers.add(issuer); this.issuer = issuer;
      await this.options.store.write(`${this.options.identity}:index`, { issuers: [...this.issuers], current: issuer });
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
}

function validateTokens(value: unknown): StoredOAuthTokens {
  if (!isRecord(value) || typeof value.access_token !== "string" || typeof value.token_type !== "string") throw new Error("Invalid stored MCP OAuth tokens");
  for (const key of ["id_token", "scope", "refresh_token", "issuer"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error("Invalid stored MCP OAuth token field");
  if (value.expires_in !== undefined && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in))) throw new Error("Invalid stored MCP OAuth expiry");
  return structuredClone(value) as StoredOAuthTokens;
}
function validateClient(value: unknown): StoredOAuthClientInformation {
  if (!isRecord(value) || typeof value.client_id !== "string") throw new Error("Invalid stored MCP OAuth registration");
  for (const key of ["client_secret", "issuer"]) if (value[key] !== undefined && typeof value[key] !== "string") throw new Error("Invalid stored MCP OAuth registration field");
  for (const key of ["client_id_issued_at", "client_secret_expires_at"]) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new Error("Invalid stored MCP OAuth registration expiry");
  if (value.redirect_uris !== undefined && (!Array.isArray(value.redirect_uris) || value.redirect_uris.some(uri => typeof uri !== "string"))) throw new Error("Invalid stored MCP OAuth redirect");
  return structuredClone(value) as StoredOAuthClientInformation;
}
