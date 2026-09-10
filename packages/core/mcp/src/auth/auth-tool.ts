import type { ToolAdapterDefinition } from "@laohuang/tools";
import { mcpToolName } from "../tool-adapter.ts";
import type { McpLoginResult } from "../types.ts";

export function createMcpAuthTool(options: { id: string; binding: string; login(signal?: AbortSignal): Promise<McpLoginResult> }): ToolAdapterDefinition {
  return {
    spec: {
      name: mcpToolName(options.id, "authenticate"),
      description: `Authenticate with MCP server "${options.id}" via OAuth. Takes no arguments. Starts login and immediately shows the user an authorization URL; the user must open it unchanged in their browser and approve access. Waits up to 15 minutes for the callback. On success, reconnects and replaces this synthetic tool with real MCP tools. The user may cancel and retry.`,
      parameters: { type: "object", properties: {}, additionalProperties: false }, promptGuidelines: [],
      catalog: { source: `mcp:${options.id}`, originalName: "authenticate", binding: `${options.binding}:synthetic-auth`, exposure: "deferred" },
    },
    executionMode: "sequential",
    execute: async (args, context) => {
      if (Object.keys(args).length) return { ok: false, error: "authenticate takes no arguments" };
      const result = await options.login(context.signal);
      return { ...result, content: result.ok ? "Authenticated and reconnected. Real MCP tools have replaced this authentication tool; search the updated catalog if needed." : "MCP authentication did not make tools available. Check the server status before continuing." };
    },
  };
}
