import { createHash } from "node:crypto";
import type { Client, Tool } from "@modelcontextprotocol/client";
import type { ToolAdapterDefinition } from "@laohuang/tools";
import type { ResolvedMcpServer } from "./types.ts";
import { adaptMcpResult } from "./output.ts";
import { recoverableConnectionError } from "./call-recovery.ts";

export function mcpToolName(serverId: string, toolName: string): string {
  const server = serverId.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 16);
  const tool = toolName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20);
  const hash = createHash("sha256").update(JSON.stringify([serverId, toolName])).digest("hex").slice(0, 16);
  return `mcp__${server}__${tool}__${hash}`;
}

export function createMcpToolAdapters(options: {
  server: ResolvedMcpServer; client: Client; tools: readonly Tool[]; artifactRoot: string;
  signal: AbortSignal; isCurrent(): boolean; onFailure(error: unknown): void;
  call?: (tool: Tool, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Awaited<ReturnType<Client["callTool"]>>>;
  binding?: string | ((tool: Tool) => string);
}): ToolAdapterDefinition[] {
  const { server, client } = options;
  const names = new Set<string>();
  return options.tools.filter(tool =>
    (server.config.allowedTools === undefined || server.config.allowedTools.includes(tool.name)) && !server.config.disabledTools?.includes(tool.name),
  ).map(tool => {
    const name = mcpToolName(server.id, tool.name);
    if (names.has(name)) throw new Error("MCP tool name collision");
    names.add(name);
    return {
      spec: { name, description: tool.description ?? "", parameters: tool.inputSchema, promptGuidelines: [],
        catalog: { source: `mcp:${server.id}`, originalName: tool.name, exposure: "deferred",
          binding: typeof options.binding === "function" ? options.binding(tool) : options.binding ?? createHash("sha256").update(JSON.stringify(server)).digest("hex") } },
      executionMode: server.config.executionMode ?? "sequential",
      execute: async (args, context) => {
        if (!options.isCurrent()) return { ok: false, status: "tool_unavailable", error: "MCP tool catalog is no longer current." };
        const signal = context.signal === undefined ? options.signal : AbortSignal.any([context.signal, options.signal]);
        try {
          signal.throwIfAborted();
          const result = options.call ? await options.call(tool, args, context.signal)
            : await client.callTool({ name: tool.name, arguments: args }, { signal, timeout: server.config.toolTimeoutMs ?? 60000 });
          return await adaptMcpResult(result, { artifactRoot: options.artifactRoot });
        } catch (error) {
          const status = context.isCancelled() ? "cancelled" : mcpErrorStatus(error);
          options.onFailure(error);
          return { ok: false, status, error: `MCP call ${status}. Remote execution may have started; do not automatically replay it.` };
        }
      },
    };
  });
}

export function mcpErrorStatus(error: unknown): "auth_required" | "timeout" | "failed" {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    const data = (error as Error & { data?: { status?: number } }).data;
    if (error.name === "UnauthorizedError" || code === 401 || code === 403 || data?.status === 401 || data?.status === 403) return "auth_required";
    if (code === "REQUEST_TIMEOUT" || error.name === "TimeoutError" || /timeout|timed out/i.test(error.message)) return "timeout";
  }
  return "failed";
}

export function isConnectionFailure(error: unknown): boolean {
  return recoverableConnectionError(error);
}
