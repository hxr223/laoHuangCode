import { createServer, type ServerResponse } from "node:http";
import type { DiscoverResult } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "../../packages/core/mcp/src/types.ts";

export async function startMcpFixture(options: {
  protocol: "legacy" | "modern"; transport: "http" | "sse";
  rejectStatus?: number; hangList?: boolean; requireBearer?: string;
  oauth?: { issuer: string; token(): string };
  listChanged?: boolean; pages?: number; callDelayMs?: number; dropCall?: boolean; dropFirstBatch?: number;
}) {
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  const streams = new Set<ServerResponse>();
  const subscriptions = new Map<ServerResponse, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const failedBatch: ServerResponse[] = [];
  let toolNames = ["echo"];
  let calls = 0;
  let url = "";
  const httpRequests: { method: string; url: string }[] = [];
  const server = createServer(async (request, response) => {
    httpRequests.push({ method: request.method ?? "", url: request.url ?? "" });
    if (options.oauth && request.url?.startsWith("/.well-known/oauth-protected-resource")) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ resource: `${url}/${options.transport === "sse" ? "sse" : "mcp"}`, authorization_servers: [options.oauth.issuer], scopes_supported: ["tools"] })); return;
    }
    if (options.oauth && request.headers.authorization !== `Bearer ${options.oauth.token()}`) {
      response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"` }).end(); return;
    }
    if (options.rejectStatus || (options.requireBearer && request.headers.authorization !== `Bearer ${options.requireBearer}`)) {
      response.writeHead(options.rejectStatus ?? 401).end(); return;
    }
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      streams.add(response);
      if (options.transport === "sse") response.write(`event: endpoint\ndata: ${url}/messages\n\n`);
      else response.write(": ready\n\n");
      request.on("close", () => streams.delete(response));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(message);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    if (message.method === "subscriptions/listen") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      streams.add(response); subscriptions.set(response, message.id);
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": message.id }, notifications: message.params.notifications,
      } })}\n\n`);
      response.on("close", () => { streams.delete(response); subscriptions.delete(response); });
      return;
    }
    let result: unknown = {};
    let error: unknown;
    switch (message.method) {
      case "server/discover":
        if (options.protocol === "legacy") error = { code: -32601, message: "Method not found" };
        else result = { supportedVersions: ["2026-07-28"], capabilities: { tools: { listChanged: options.listChanged ?? false }, resources: {}, prompts: {} } } satisfies DiscoverResult;
        break;
      case "initialize": result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } }; break;
      case "tools/list":
        if (options.hangList) return;
        result = { tools: toolNames.map(name => ({ name: options.pages ? `${name}_${Number(message.params?.cursor ?? 0)}` : name, description: "echo", inputSchema: { type: "object", properties: {} } })),
          ...(options.pages && Number(message.params?.cursor ?? 0) + 1 < options.pages ? { nextCursor: String(Number(message.params?.cursor ?? 0) + 1) } : {}) };
        break;
      case "tools/call":
        calls++;
        if (options.dropCall) { response.destroy(); return; }
        if (calls <= (options.dropFirstBatch ?? 0)) {
          // All initial calls must arrive before reconnect can abort their transport.
          failedBatch.push(response);
          if (failedBatch.length === options.dropFirstBatch) {
            for (const pending of failedBatch) pending.destroy();
            failedBatch.length = 0;
          }
          return;
        }
        result = { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] }; break;
      case "resources/list": result = { resources: [{ uri: "fixture://text", name: "text" }] }; break;
      case "resources/templates/list": result = { resourceTemplates: [] }; break;
      case "resources/read": result = { contents: [{ uri: "fixture://text", text: "resource" }] }; break;
      case "prompts/list": result = { prompts: [{ name: "hello" }] }; break;
      case "prompts/get": result = { messages: [{ role: "user", content: { type: "text", text: "hello" } }] }; break;
      default: error = { code: -32601, message: "Method not found" };
    }
    if (options.protocol === "modern" && typeof result === "object" && result !== null) result = { ...result, resultType: "complete", ttlMs: 0, cacheScope: "private" };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
    if (message.method === "tools/call" && options.callDelayMs) {
      const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200, { "Content-Type": "application/json" }).end(payload); }, options.callDelayMs);
      timers.add(timer); return;
    }
    if (options.transport === "sse") {
      for (const stream of streams) stream.write(`event: message\ndata: ${payload}\n\n`);
      response.writeHead(202).end();
    } else response.writeHead(200, { "Content-Type": "application/json" }).end(payload);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listen failed");
  url = `http://127.0.0.1:${address.port}`;
  return {
    config: { transport: options.transport, url: `${url}/${options.transport === "sse" ? "sse" : "mcp"}` } satisfies McpServerConfig,
    requests,
    httpRequests,
    calls: () => calls,
    changeTools(names: string[]) {
      toolNames = names;
      for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed",
        ...(subscriptions.has(stream) ? { params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptions.get(stream) } } } : {}) })}\n\n`);
    },
    close: () => new Promise<void>(resolve => { for (const timer of timers) clearTimeout(timer); for (const stream of streams) stream.end(); server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
