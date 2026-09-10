import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ToolRegistry } from "../packages/core/tools/src/index.ts";
import { createMcpService } from "../packages/core/mcp/src/index.ts";
import type { McpServerConfig } from "../packages/core/mcp/src/types.ts";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";

function runtime(configs: McpServerConfig[]) {
  const registry = new ToolRegistry([]);
  const service = createMcpService({ servers: configs.map((config, i) => ({ id: `server${i}`, sourcePath: "/config/mcp.json", config })),
    projectRoot: process.cwd(), version: "test", artifactRoot: "/unused",
    credentials: { read: async () => undefined, write: async () => {}, remove: async () => {} }, env: {},
    onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: () => {} });
  return { registry, service };
}

test("empty service does not connect and is safe to start and close repeatedly", async () => {
  const { service } = runtime([]);
  await Promise.all([service.start(), service.start()]);
  assert.deepEqual(service.status(), []);
  await service.close(); await service.close();
});

test("logout without OAuth reports a configuration error without changing the connection state", async () => {
  const { service } = runtime([{ transport: "stdio", command: "unused" }]);
  try { await assert.rejects(service.logout("server0"), /OAuth is not configured/); assert.equal(service.status()[0]?.state, "idle"); }
  finally { await service.close(); }
});

for (const protocol of ["legacy", "modern"] as const) {
  for (const transport of ["stdio", "http", ...(protocol === "legacy" ? ["sse" as const] : [])] as const) {
    test(`${protocol} ${transport}: discovers and executes through the registry`, async () => {
      const fixture = transport === "stdio" ? undefined : await startMcpFixture({ protocol, transport });
      const config: McpServerConfig = fixture?.config ?? { transport: "stdio", command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url)), protocol] };
      const { service, registry } = runtime([config]);
      try {
        await service.start();
        assert.equal(service.status()[0]?.state, "ready", JSON.stringify(service.status()));
        assert.equal(service.status()[0]?.protocolVersion, protocol === "modern" ? "2026-07-28" : "2025-11-25");
        assert.equal(registry.definitions.length, 1);
        const result = await registry.execute(registry.definitions[0]!.name, { value: "hello" });
        assert.equal(result.ok, true);
        assert.equal(result.content, '{"value":"hello"}');
        if (transport !== "stdio") {
          assert.equal((await service.listResources("server0")).resources.length, 1);
          assert.equal((await service.getPrompt("server0", "hello", {})).messages.length, 1);
        }
      } finally { await service.close(); await fixture?.close(); }
      assert.equal(registry.definitions.length, 0);
    });
  }
}

test("one server timeout does not prevent another connecting; cancelling a wait does not close either", async () => {
  const slow = await startMcpFixture({ protocol: "legacy", transport: "http", hangList: true });
  const good = await startMcpFixture({ protocol: "modern", transport: "http" });
  const { service, registry } = runtime([{ ...slow.config, startupTimeoutMs: 100 }, good.config]);
  try {
    const started = service.start();
    const controller = new AbortController();
    const wait = service.waitUntilReady(controller.signal);
    controller.abort();
    await assert.rejects(wait);
    await started;
    assert.equal(service.status()[0]?.state, "failed");
    assert.equal(service.status()[1]?.state, "ready");
    assert.equal(registry.definitions.length, 1);
  } finally { await service.close(); await slow.close(); await good.close(); }
});

test("401 is an authentication failure and does not trigger legacy/SSE fallback", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", rejectStatus: 401 });
  const { service } = runtime([fixture.config]);
  try { await service.start(); assert.notEqual(service.status()[0]?.state, "ready"); assert.deepEqual(fixture.httpRequests.map(r => r.method), ["POST"]); }
  finally { await service.close(); await fixture.close(); }
});

for (const protocol of ["legacy", "modern"] as const) {
  test(`pinned modern protocol ${protocol === "modern" ? "connects" : "rejects legacy without fallback"}`, async () => {
    const fixture = await startMcpFixture({ protocol, transport: "http" });
    const { service } = runtime([{ ...fixture.config, protocol: "2026-07-28" }]);
    try {
      await service.start();
      assert.equal(service.status()[0]?.state, protocol === "modern" ? "ready" : "failed");
      assert.ok(fixture.requests.every(request => request.method !== "initialize"));
      if (protocol === "modern") {
        assert.equal((await service.readResource("server0", "fixture://text")).contents.length, 1);
        assert.equal((await service.listResourceTemplates("server0")).resourceTemplates.length, 0);
        assert.equal((await service.listPrompts("server0")).prompts.length, 1);
      }
    } finally { await service.close(); await fixture.close(); }
  });
}
