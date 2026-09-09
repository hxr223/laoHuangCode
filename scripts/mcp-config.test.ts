import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpConfig, resolveMcpServers, resolveSecretValues } from "../packages/core/mcp/src/config.ts";

test("project server replaces the whole global entry", () => {
  const result = resolveMcpServers([
    { path: "/global/mcp.json", value: { version: 1, servers: { x: { transport: "http", url: "https://example.test", headers: { key: "old" } } } } },
    { path: "/project/mcp.json", value: { version: 1, servers: { x: { transport: "stdio", command: "node", enabled: false } } } },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { id: "x", sourcePath: "/project/mcp.json", config: { transport: "stdio", command: "node", enabled: false } });
});

test("invalid config rejects the document without exposing secret values", () => {
  for (const config of [
    { transport: "stdio", command: "node", args: "secret-value" },
    { transport: "http", url: "https://user:secret-value@example.test" },
    { transport: "sse", url: "https://example.test", protocol: "auto" },
    { transport: "http", url: "https://example.test", auth: { type: "oauth" }, headers: { Authorization: "secret-value" } },
    { transport: "stdio", command: "node", startupTimeoutMs: 2147483648 },
    { transport: "stdio", command: "node", unknown: "secret-value" },
  ]) {
    assert.throws(() => parseMcpConfig({ version: 1, servers: { bad: config } }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("secret-value"));
      return true;
    });
  }
  assert.throws(() => parseMcpConfig({ version: 2, servers: {} }));
});

test("environment references are explicit and do not evaluate shell text", () => {
  assert.deepEqual(resolveSecretValues({ a: { env: "TOKEN" }, b: "$(whoami)" }, { TOKEN: "value" }), { a: "value", b: "$(whoami)" });
  assert.throws(() => resolveSecretValues({ a: { env: "MISSING" } }, {}), /MISSING/);
});
