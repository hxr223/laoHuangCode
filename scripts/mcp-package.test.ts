import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("published CLI owns the SDK runtime dependency and internal MCP stays private", async () => {
  const app = JSON.parse(await readFile(new URL("../apps/cli/package.json", import.meta.url), "utf8"));
  const mcp = JSON.parse(await readFile(new URL("../packages/core/mcp/package.json", import.meta.url), "utf8"));
  assert.equal(app.dependencies["@modelcontextprotocol/client"], "2.0.0");
  assert.equal(mcp.dependencies["@modelcontextprotocol/client"], "2.0.0");
  assert.equal(mcp.private, true); assert.equal(mcp.version, "0.0.0");
  assert.deepEqual(Object.keys(mcp.exports), ["."]);
  assert.equal(typeof Client, "function"); assert.equal(typeof StdioClientTransport, "function");
});
