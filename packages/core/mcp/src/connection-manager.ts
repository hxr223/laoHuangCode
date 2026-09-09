import { SdkError, SdkErrorCode, type Client, type Tool } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { canonicalToolJson } from "@laohuang/tools";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpService, McpServiceOptions, McpServerStatus, ResolvedMcpServer, McpLoginResult } from "./types.ts";
import { parseMcpConfig } from "./config.ts";
import { createMcpClient, waitWithSignal } from "./client.ts";
import { createMcpTransport, type McpTransport } from "./transports.ts";
import { createMcpToolAdapters, mcpErrorStatus, isConnectionFailure } from "./tool-adapter.ts";
import { McpOAuthProvider } from "./auth/provider.ts";
import { authorizeMcp } from "./auth/auth-service.ts";
import { createMcpAuthTool } from "./auth/auth-tool.ts";
import { callWithRecovery } from "./call-recovery.ts";
import { validateCatalogSize } from "./catalog-limits.ts";

interface Connection {
  client: Client; transport: McpTransport; controller: AbortController; provider?: McpOAuthProvider;
}
interface Entry {
  server: ResolvedMcpServer; status: McpServerStatus; generation: number;
  connection?: Connection; pending?: Promise<void>; refresh?: Promise<void>; dirty: boolean;
  lifetime: AbortController; binding: string; tools: readonly Tool[];
  toolRevisions: Map<string, number>;
}

export function createMcpService(options: McpServiceOptions): McpService { return new ConnectionManager(options); }

class ConnectionManager implements McpService {
  private readonly options: McpServiceOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly bindingRevisions = new Map<string, number>();
  private initial: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private mutation = Promise.resolve();
  private authorization: { id: string; controller: AbortController; work: Promise<McpLoginResult>; urls: Set<(url: string) => void>; url?: string } | undefined;

  constructor(options: McpServiceOptions) {
    this.options = options;
    for (const server of options.servers) this.entries.set(server.id, this.entry(server));
  }
  private entry(server: ResolvedMcpServer): Entry {
    parseMcpConfig({ version: 1, servers: { [server.id]: server.config } });
    const revision = (this.bindingRevisions.get(server.id) ?? -1) + 1;
    this.bindingRevisions.set(server.id, revision);
    return { server, generation: 0, dirty: false, lifetime: new AbortController(), tools: [], toolRevisions: new Map(),
      binding: createHash("sha256").update(canonicalToolJson([server, revision])).digest("hex"),
      status: { id: server.id, state: server.config.enabled === false ? "disabled" : "idle",
      transport: server.config.transport, protocolVersion: null, toolCount: 0, error: null } };
  }
  status(): readonly McpServerStatus[] { return [...this.entries.values()].map(entry => ({ ...entry.status })); }
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.initial ??= this.connectEntries([...this.entries.values()]);
    return this.initial;
  }
  waitUntilReady(signal?: AbortSignal): Promise<void> { return waitWithSignal(this.start(), signal); }
  private async connectEntries(entries: Entry[]): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (next < entries.length && !this.closed) {
        const entry = entries[next++];
        if (entry !== undefined && entry.server.config.enabled !== false) await this.connect(entry);
      }
    }));
  }
  private emit(entry: Entry, patch: Partial<McpServerStatus>): void {
    entry.status = { ...entry.status, ...patch };
    try { this.options.onStatus({ ...entry.status }); } catch { /* Presentation cannot own connection lifetime. */ }
  }
  private revoke(entry: Entry): void {
    entry.generation++;
    this.options.onToolsChanged(`mcp:${entry.server.id}`, []);
    entry.status = { ...entry.status, toolCount: 0 };
  }
  private async release(entry: Entry): Promise<void> {
    const connection = entry.connection;
    entry.connection = undefined;
    try { this.revoke(entry); }
    catch { this.emit(entry, { error: "MCP tool catalog revocation failed" }); }
    if (!connection) return;
    connection.controller.abort(new SdkError(SdkErrorCode.ConnectionClosed, "MCP connection closed"));
    connection.provider?.dispose();
    const cleanup = Promise.allSettled([connection.client.close(), connection.transport.close()]);
    try { await waitWithSignal(cleanup, AbortSignal.timeout(5000)); } catch { this.emit(entry, { error: "MCP close deadline exceeded" }); }
  }
  private connect(entry: Entry, login?: { showUrl: (url: string) => void; signal?: AbortSignal }): Promise<void> {
    if (entry.pending) return entry.pending;
    const work = this.connectNow(entry, login).finally(() => { if (entry.pending === work) entry.pending = undefined; });
    entry.pending = work;
    return work;
  }
  private async connectNow(entry: Entry, login?: { showUrl: (url: string) => void; signal?: AbortSignal }): Promise<void> {
    await this.release(entry);
    if (this.closed || entry.lifetime.signal.aborted || entry.server.config.enabled === false) return;
    const generation = entry.generation;
    const current = () => !this.closed && !entry.lifetime.signal.aborted && this.entries.get(entry.server.id) === entry && entry.generation === generation;
    const controller = new AbortController();
    const { config } = entry.server;
    this.emit(entry, { state: "connecting", protocolVersion: null, error: null });
    let connection: Connection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let authorized = false;
    try {
      const provider = config.transport !== "stdio" && config.auth ? new McpOAuthProvider({
        identity: JSON.stringify([entry.server.sourcePath, entry.server.id, new URL(config.url).toString()]),
        store: this.options.credentials, config: config.auth, env: this.options.env,
      }) : undefined;
      const client = createMcpClient(config, this.options.version, () => {
        if (!current()) return;
        if (entry.status.state === "ready") void this.refresh(entry).catch(() => {});
        else entry.dirty = true;
      });
      const transport = createMcpTransport({ server: entry.server, projectRoot: this.options.projectRoot, env: this.options.env, provider,
        fetch: (input, init) => {
          const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          return (provider?.fetch ?? fetch)(input, { ...init, signal: requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal });
        } });
      connection = { client, transport, controller, provider };
      entry.connection = connection;
      client.onclose = () => {
        if (current() && entry.status.state === "ready") {
          this.emit(entry, { state: "failed", error: "MCP connection closed" });
          void this.release(entry);
        }
      };
      // SDK errors may contain headers/URLs. Only classified errors leave this boundary.
      client.onerror = () => {};
      if (login) {
        if (!provider || transport instanceof StdioClientTransport || config.transport === "stdio") throw new Error("MCP OAuth is not configured");
        await authorizeMcp({ provider, transport, serverUrl: config.url, showUrl: login.showUrl,
          signal: login.signal ? AbortSignal.any([controller.signal, login.signal]) : controller.signal });
        authorized = true;
      }
      timer = setTimeout(() => controller.abort(new DOMException("MCP startup timed out", "TimeoutError")), config.startupTimeoutMs ?? 30000);
      await waitWithSignal(client.connect(transport, { signal: controller.signal, timeout: config.startupTimeoutMs ?? 30000 }), controller.signal);
      const tools = await waitWithSignal(client.listTools(undefined, { signal: controller.signal, timeout: config.startupTimeoutMs ?? 30000 }), controller.signal);
      if (!current()) return;
      this.publishTools(entry, connection, tools.tools);
      this.emit(entry, { state: "ready", protocolVersion: client.getNegotiatedProtocolVersion() ?? null, error: null });
      if (entry.dirty) await this.refresh(entry);
    } catch (error) {
      if (!current()) return;
      const state = mcpErrorStatus(error) === "auth_required" ? "auth_required" : "failed";
      this.emit(entry, { state, error: state === "auth_required" ? "Authorization required; use /mcp login." : login
        ? "MCP login failed or was cancelled. Check OAuth registration, clientId, scopes and server availability."
        : "MCP connection or discovery failed; check configuration and server availability." });
      await this.release(entry);
      if (state === "auth_required" || login && !authorized) this.publishAuth(entry);
    } finally {
      clearTimeout(timer);
      if (connection && entry.connection !== connection) {
        connection.controller.abort(); connection.provider?.dispose();
        void connection.client.close().catch(() => {});
        void connection.transport.close().catch(() => {});
      }
    }
  }
  private publishTools(entry: Entry, connection: Connection, tools: Awaited<ReturnType<Client["listTools"]>>["tools"]): void {
    validateCatalogSize(tools);
    const next = new Map(tools.map(tool => [tool.name, canonicalToolJson(tool)]));
    const revisions = new Map(entry.toolRevisions);
    for (const previous of entry.tools) {
      if (next.get(previous.name) !== canonicalToolJson(previous)) revisions.set(previous.name, (revisions.get(previous.name) ?? 0) + 1);
    }
    const adapters = createMcpToolAdapters({ server: entry.server, client: connection.client, tools, artifactRoot: this.options.artifactRoot,
      binding: tool => `${entry.binding}:${revisions.get(tool.name) ?? 0}`,
      call: (tool, args, signal) => this.call(entry, connection, tool, args, signal),
      signal: connection.controller.signal, isCurrent: () => entry.connection === connection && !connection.controller.signal.aborted,
      onFailure: error => {
        if (mcpErrorStatus(error) === "auth_required" && entry.connection === connection) {
          entry.binding = createHash("sha256").update(entry.binding + ":auth-required").digest("hex");
          this.emit(entry, { state: "auth_required", error: "MCP authorization required" });
          void this.release(entry).then(() => this.publishAuth(entry));
        } else if (isConnectionFailure(error) && this.entries.get(entry.server.id) === entry) {
          this.emit(entry, { state: "failed", error: "MCP connection failed; use /mcp reconnect" }); void this.release(entry);
        }
      } });
    this.options.onToolsChanged(`mcp:${entry.server.id}`, adapters);
    entry.tools = tools;
    entry.toolRevisions = revisions;
    entry.status = { ...entry.status, toolCount: adapters.length };
  }
  private call(entry: Entry, connection: Connection, tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) {
    const lifetime = entry.lifetime;
    const binding = entry.binding;
    const revision = entry.toolRevisions.get(tool.name) ?? 0;
    const logicalSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const check = () => {
      logicalSignal.throwIfAborted();
      if (this.closed || this.entries.get(entry.server.id) !== entry || entry.lifetime !== lifetime) throw new Error("MCP binding changed");
      if (entry.binding !== binding || (entry.toolRevisions.get(tool.name) ?? 0) !== revision) throw new Error("MCP tool binding changed");
      if (entry.server.config.allowedTools && !entry.server.config.allowedTools.includes(tool.name) || entry.server.config.disabledTools?.includes(tool.name)) throw new Error("MCP tool disabled");
    };
    return callWithRecovery({
      client: connection, check,
      call: async active => {
        check();
        if (!entry.tools.some(current => current.name === tool.name && canonicalToolJson(current) === canonicalToolJson(tool))) throw new Error("MCP tool definition changed");
        return active.client.callTool({ name: tool.name, arguments: args }, {
          signal: AbortSignal.any([logicalSignal, active.controller.signal]), timeout: entry.server.config.toolTimeoutMs ?? 60000,
        });
      },
      ping: async active => { await active.client.ping({ signal: AbortSignal.any([logicalSignal, active.controller.signal]), timeout: entry.server.config.probeTimeoutMs ?? 5000 }); },
      reconnect: async stale => {
        check();
        if (entry.connection === stale || !entry.connection || entry.status.state !== "ready") await waitWithSignal(this.connect(entry), logicalSignal);
        check();
        if (!entry.connection || entry.status.state !== "ready") throw new Error("MCP reconnection failed");
        return entry.connection;
      },
      update: () => this.emit(entry, { error: "MCP connection lost; reconnecting and retrying tool call" }),
    });
  }

  private publishAuth(entry: Entry): void {
    const config = entry.server.config;
    if (this.closed || this.entries.get(entry.server.id) !== entry || entry.lifetime.signal.aborted || config.enabled === false || config.transport === "stdio" || !config.auth || config.allowedTools?.length === 0) return;
    this.options.onToolsChanged(`mcp:${entry.server.id}`, [createMcpAuthTool({ id: entry.server.id, binding: entry.binding,
      login: signal => {
        if (!this.options.onAuthorization) return Promise.resolve({ ok: false, status: "auth_required", error: "No authorization UI is configured; use /mcp login." });
        return this.login(entry.server.id, url => this.options.onAuthorization?.({ serverId: entry.server.id, url, expiresAt: Date.now() + 900000 }), signal);
      },
    })]);
  }
  private refresh(entry: Entry): Promise<void> {
    entry.dirty = true;
    if (entry.refresh) return entry.refresh;
    const work = (async () => {
      while (entry.dirty && !this.closed) {
        entry.dirty = false;
        const connection = entry.connection;
        if (!connection || entry.status.state !== "ready") return;
        try {
          const tools = await connection.client.listTools(undefined, { cacheMode: "refresh", signal: connection.controller.signal, timeout: entry.server.config.startupTimeoutMs ?? 30000 });
          if (entry.connection === connection && !this.closed) { this.publishTools(entry, connection, tools.tools); this.emit(entry, { error: null }); }
        } catch { if (entry.connection === connection) this.emit(entry, { error: "MCP catalog refresh failed; previous catalog retained" }); }
      }
    })().finally(() => { if (entry.refresh === work) entry.refresh = undefined; });
    entry.refresh = work;
    return work;
  }
  reload(servers: readonly ResolvedMcpServer[]): Promise<void> {
    const validated = servers.map(server => this.entry(server));
    const work = this.mutation.then(async () => {
      if (this.closed) return;
      await this.start();
      const nextIds = new Set(servers.map(server => server.id));
      for (const [id, entry] of this.entries) if (!nextIds.has(id)) { entry.lifetime.abort(); await this.release(entry); this.entries.delete(id); }
      const changed: Entry[] = [];
      for (const next of validated) {
        const previous = this.entries.get(next.server.id);
        if (previous && JSON.stringify(previous.server) === JSON.stringify(next.server) && previous.status.state === "ready") { await this.refresh(previous); continue; }
        if (previous) { previous.lifetime.abort(); await this.release(previous); }
        this.entries.set(next.server.id, next);
        changed.push(next);
      }
      await this.connectEntries(changed);
    });
    this.mutation = work.catch(() => {});
    return work;
  }
  reconnect(id: string): Promise<void> { return this.connect(this.get(id)); }
  async login(id: string, showUrl: (url: string) => void, signal?: AbortSignal): Promise<McpLoginResult> {
    const entry = this.get(id);
    if (entry.server.config.transport === "stdio" || !entry.server.config.auth) return Promise.reject(new Error("Configure auth.type = oauth for this remote MCP server first."));
    if (this.authorization && this.authorization.id !== id) throw new Error("Another MCP login is already running");
    if (!this.authorization) {
      const controller = new AbortController();
      const urls = new Set<(url: string) => void>();
      const state = { id, controller, urls, url: undefined as string | undefined, work: Promise.resolve<McpLoginResult>({ ok: false, status: "auth_required" }) };
      this.authorization = state;
      state.work = Promise.resolve().then(async () => {
        this.options.onLoginState?.(true);
        const authSignal = AbortSignal.any([controller.signal, entry.lifetime.signal]);
        await waitWithSignal(entry.pending ?? Promise.resolve(), authSignal);
        authSignal.throwIfAborted();
        await this.connect(entry, { signal: authSignal, showUrl: url => { state.url = url; for (const show of urls) show(url); } });
        return entry.status.state === "ready" ? { ok: true, status: "completed" } : { ok: false, status: authSignal.aborted ? "cancelled" : entry.status.state, error: entry.status.error ?? "MCP login failed" };
      }).catch(() => ({ ok: false, status: controller.signal.aborted ? "cancelled" : "failed", error: "MCP login failed or was cancelled" })).finally(() => {
        if (this.authorization === state) this.authorization = undefined;
        this.options.onLoginState?.(false);
      });
    }
    const active = this.authorization;
    active.urls.add(showUrl);
    if (active.url) showUrl(active.url);
    const abort = () => active.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await active.work; }
    finally { active.urls.delete(showUrl); signal?.removeEventListener("abort", abort); }
  }
  cancelAuthorization(): boolean {
    if (!this.authorization) return false;
    this.authorization.controller.abort(new Error("MCP login cancelled")); return true;
  }
  async logout(id: string): Promise<void> {
    const entry = this.get(id);
    const config = entry.server.config;
    if (config.transport === "stdio" || !config.auth) throw new Error("OAuth is not configured for this MCP server.");
    const provider = entry.connection?.provider;
    entry.lifetime.abort();
    await this.release(entry);
    const credentials = provider ?? new McpOAuthProvider({ identity: JSON.stringify([entry.server.sourcePath, id, new URL(config.url).toString()]), store: this.options.credentials, config: config.auth, env: this.options.env });
    await credentials.logout();
    entry.lifetime = new AbortController();
    entry.binding = createHash("sha256").update(entry.binding + ":logout").digest("hex");
    this.emit(entry, { state: "auth_required", error: "Locally logged out" });
    this.publishAuth(entry);
  }
  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry || this.closed) throw new Error("Unknown or closed MCP server");
    if (entry.server.config.enabled === false) throw new Error("MCP server is disabled");
    return entry;
  }
  private ready(id: string, signal?: AbortSignal): { client: Client; request: { signal: AbortSignal; timeout: number } } {
    const entry = this.get(id);
    if (!entry.connection || entry.status.state !== "ready") throw new Error("MCP server is not ready");
    return { client: entry.connection.client, request: { signal: signal ? AbortSignal.any([signal, entry.connection.controller.signal]) : entry.connection.controller.signal, timeout: entry.server.config.toolTimeoutMs ?? 60000 } };
  }
  listResources(id: string, signal?: AbortSignal) { const { client, request } = this.ready(id, signal); return client.listResources(undefined, request); }
  listResourceTemplates(id: string, signal?: AbortSignal) { const { client, request } = this.ready(id, signal); return client.listResourceTemplates(undefined, request); }
  readResource(id: string, uri: string, signal?: AbortSignal) { const { client, request } = this.ready(id, signal); return client.readResource({ uri }, request); }
  listPrompts(id: string, signal?: AbortSignal) { const { client, request } = this.ready(id, signal); return client.listPrompts(undefined, request); }
  getPrompt(id: string, name: string, args: Record<string, string>, signal?: AbortSignal) { const { client, request } = this.ready(id, signal); return client.getPrompt({ name, arguments: args }, request); }
  close(): Promise<void> {
    this.closed = true;
    this.cancelAuthorization();
    for (const entry of this.entries.values()) entry.lifetime.abort();
    this.closing ??= Promise.allSettled([...this.entries.values()].map(async entry => { await this.release(entry); this.emit(entry, { state: "closed" }); })).then(() => {});
    return this.closing;
  }
}
