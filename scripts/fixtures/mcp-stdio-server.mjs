import { createInterface } from "node:readline";
const modern = process.argv.includes("modern");
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  let error;
  if (message.method === "server/discover") {
    if (modern) result = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
    else error = { code: -32601, message: "Method not found" };
  } else if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stdio-fixture", version: "1" } };
  else if (message.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  else if (message.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] };
  else error = { code: -32601, message: "Method not found" };
  if (modern) result = { ...result, resultType: "complete", ttlMs: 0, cacheScope: "private" };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) }) + "\n");
});
