import type { Client } from "@modelcontextprotocol/client";
import type { ToolAdapterDefinition, ToolExecutionMode } from "@laohuang/tools";

export type McpSecretValue = string | { readonly env: string };
export type McpProtocol = "auto" | "legacy" | "2026-07-28";
export interface McpCommonConfig {
  readonly enabled?: boolean;
  readonly protocol?: McpProtocol;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly allowedTools?: readonly string[];
  readonly disabledTools?: readonly string[];
  readonly executionMode?: ToolExecutionMode;
}
export interface McpOAuthConfig {
  readonly type: "oauth";
  readonly clientId?: string;
  readonly clientSecretEnv?: string;
  readonly scopes?: readonly string[];
}
export type McpServerConfig = McpCommonConfig & (
  | { readonly transport: "stdio"; readonly command: string; readonly args?: readonly string[];
      readonly cwd?: string; readonly env?: Readonly<Record<string, McpSecretValue>> }
  | { readonly transport: "http" | "sse"; readonly url: string;
      readonly headers?: Readonly<Record<string, McpSecretValue>>; readonly auth?: McpOAuthConfig }
);
export interface McpConfigDocument { readonly version: 1; readonly servers: Readonly<Record<string, McpServerConfig>> }
export interface McpConfigSource { readonly path: string; readonly value: unknown }
export interface ResolvedMcpServer { readonly id: string; readonly sourcePath: string; readonly config: McpServerConfig }
export interface McpCredentialStore {
  read(key: string): Promise<unknown | undefined>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
export type McpState = "disabled" | "idle" | "connecting" | "ready" | "auth_required" | "failed" | "closed";
export interface McpServerStatus {
  readonly id: string;
  readonly state: McpState;
  readonly transport: "stdio" | "http" | "sse";
  readonly protocolVersion: string | null;
  readonly toolCount: number;
  readonly error: string | null;
}
export type McpToolResult = Awaited<ReturnType<Client["callTool"]>>;
export type McpResources = Awaited<ReturnType<Client["listResources"]>>;
export type McpResourceTemplates = Awaited<ReturnType<Client["listResourceTemplates"]>>;
export type McpPrompts = Awaited<ReturnType<Client["listPrompts"]>>;
export type McpResource = Awaited<ReturnType<Client["readResource"]>>;
export type McpPrompt = Awaited<ReturnType<Client["getPrompt"]>>;
export interface McpServiceOptions {
  /** Ephemeral UI channel. Never forward authorization URLs to model history or ordinary logs. */
  readonly onAuthorization?: (event: { serverId: string; url: string; expiresAt: number }) => void;
  readonly onLoginState?: (active: boolean) => void;
  readonly servers: readonly ResolvedMcpServer[];
  readonly projectRoot: string;
  readonly version: string;
  readonly artifactRoot: string;
  readonly credentials: McpCredentialStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly onToolsChanged: (owner: string, tools: readonly ToolAdapterDefinition[]) => void;
  readonly onStatus: (status: McpServerStatus) => void;
}
export interface McpService {
  start(): Promise<void>;
  waitUntilReady(signal?: AbortSignal): Promise<void>;
  status(): readonly McpServerStatus[];
  reload(servers: readonly ResolvedMcpServer[]): Promise<void>;
  reconnect(serverId: string): Promise<void>;
  login(serverId: string, showUrl: (url: string) => void, signal?: AbortSignal): Promise<McpLoginResult>;
  cancelAuthorization(): boolean;
  logout(serverId: string): Promise<void>;
  listResources(serverId: string, signal?: AbortSignal): Promise<McpResources>;
  listResourceTemplates(serverId: string, signal?: AbortSignal): Promise<McpResourceTemplates>;
  readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<McpResource>;
  listPrompts(serverId: string, signal?: AbortSignal): Promise<McpPrompts>;
  getPrompt(serverId: string, name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpPrompt>;
  close(): Promise<void>;
}

export interface McpLoginResult { readonly ok: boolean; readonly status: string; readonly error?: string }
