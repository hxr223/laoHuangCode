import { resolve } from "node:path";
import type { McpConfigDocument, McpConfigSource, McpSecretValue, ResolvedMcpServer } from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(path: string): never { throw new Error(`Invalid MCP configuration field: ${path}`); }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path}.${key}`);
}
function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) invalid(path);
}
function stringList(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || v.includes("\0"))) invalid(path);
}
function secretMap(value: unknown, path: string): void {
  if (!isRecord(value)) invalid(path);
  for (const [key, entry] of Object.entries(value)) {
    text(key, path);
    if (typeof entry === "string" && !entry.includes("\0")) continue;
    if (!isRecord(entry)) invalid(`${path}.${key}`);
    keys(entry, ["env"], `${path}.${key}`);
    text(entry.env, `${path}.${key}.env`);
  }
}

export function parseMcpConfig(value: unknown): McpConfigDocument {
  if (!isRecord(value)) invalid("root");
  keys(value, ["version", "servers"], "root");
  if (value.version !== 1) invalid("version");
  if (!isRecord(value.servers)) invalid("servers");
  for (const [id, config] of Object.entries(value.servers)) {
    text(id, "servers.name");
    const path = `servers.${id}`;
    if (!isRecord(config)) invalid(path);
    const common = ["transport", "enabled", "protocol", "startupTimeoutMs", "toolTimeoutMs", "probeTimeoutMs", "allowedTools", "disabledTools", "executionMode"];
    const stdio = config.transport === "stdio";
    if (!stdio && config.transport !== "http" && config.transport !== "sse") invalid(`${path}.transport`);
    keys(config, [...common, ...(stdio ? ["command", "args", "cwd", "env"] : ["url", "headers", "auth"])], path);
    if (config.enabled !== undefined && typeof config.enabled !== "boolean") invalid(`${path}.enabled`);
    if (config.protocol !== undefined && (typeof config.protocol !== "string" || !["auto", "legacy", "2026-07-28"].includes(config.protocol))) invalid(`${path}.protocol`);
    if (config.transport === "sse" && config.protocol !== undefined && config.protocol !== "legacy") invalid(`${path}.protocol`);
    if (config.executionMode !== undefined && (typeof config.executionMode !== "string" || !["parallel", "sequential"].includes(config.executionMode))) invalid(`${path}.executionMode`);
    for (const key of ["startupTimeoutMs", "toolTimeoutMs", "probeTimeoutMs"]) {
      const timeout = config[key];
      if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)) invalid(`${path}.${key}`);
    }
    for (const key of ["allowedTools", "disabledTools"]) if (config[key] !== undefined) stringList(config[key], `${path}.${key}`);
    if (stdio) {
      text(config.command, `${path}.command`);
      if (config.args !== undefined) stringList(config.args, `${path}.args`);
      if (config.cwd !== undefined) text(config.cwd, `${path}.cwd`);
      if (config.env !== undefined) secretMap(config.env, `${path}.env`);
    } else {
      text(config.url, `${path}.url`);
      let url: URL;
      try { url = new URL(config.url); } catch { invalid(`${path}.url`); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid(`${path}.url`);
      if (config.headers !== undefined) secretMap(config.headers, `${path}.headers`);
      if (config.auth !== undefined) {
        if (!isRecord(config.auth)) invalid(`${path}.auth`);
        keys(config.auth, ["type", "clientId", "clientSecretEnv", "scopes"], `${path}.auth`);
        if (config.auth.type !== "oauth") invalid(`${path}.auth.type`);
        for (const key of ["clientId", "clientSecretEnv"]) if (config.auth[key] !== undefined) text(config.auth[key], `${path}.auth.${key}`);
        if (config.auth.clientSecretEnv !== undefined && config.auth.clientId === undefined) invalid(`${path}.auth.clientId`);
        if (config.auth.scopes !== undefined) stringList(config.auth.scopes, `${path}.auth.scopes`);
        if (isRecord(config.headers) && Object.keys(config.headers).some(k => k.toLowerCase() === "authorization")) invalid(`${path}.headers.Authorization`);
      }
    }
  }
  return structuredClone(value) as unknown as McpConfigDocument;
}

export function resolveMcpServers(sources: readonly McpConfigSource[]): readonly ResolvedMcpServer[] {
  const servers = new Map<string, ResolvedMcpServer>();
  for (const source of sources) {
    for (const [id, config] of Object.entries(parseMcpConfig(source.value).servers)) {
      servers.set(id, { id, sourcePath: resolve(source.path), config });
    }
  }
  return [...servers.values()];
}

export function resolveSecretValues(values: Readonly<Record<string, McpSecretValue>> | undefined, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => {
    if (typeof value === "string") return [key, value];
    const resolved = env[value.env];
    if (!resolved) throw new Error(`MCP environment variable is missing: ${value.env}`);
    return [key, resolved];
  }));
}

export function validateMcpEnvironment(document: McpConfigDocument, env: Readonly<Record<string, string | undefined>>): void {
  for (const [id, config] of Object.entries(document.servers)) {
    if (config.enabled === false) continue;
    const fields = config.transport === "stdio" ? config.env : config.headers;
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (typeof value !== "string" && !env[value.env]) invalid(`servers.${id}.${config.transport === "stdio" ? "env" : "headers"}.${key}.env`);
    }
    if (config.transport !== "stdio" && config.auth?.clientSecretEnv && !env[config.auth.clientSecretEnv]) invalid(`servers.${id}.auth.clientSecretEnv`);
  }
}
