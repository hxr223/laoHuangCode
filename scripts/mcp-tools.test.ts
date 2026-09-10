import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ToolRegistry } from "../packages/core/tools/src/index.ts";
import { createMcpService } from "../packages/core/mcp/src/index.ts";
import type { McpServerConfig } from "../packages/core/mcp/src/types.ts";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";
import { validateCatalogSize, MCP_MAX_TOOLS, MCP_MAX_CATALOG_BYTES } from "../packages/core/mcp/src/catalog-limits.ts";

function runtime(config: McpServerConfig) {
  const registry = new ToolRegistry([]);
  const service = createMcpService({ servers: [{ id: "test", sourcePath: "/config", config }], projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
    credentials: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: () => {} });
  return { registry, service };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  assert.fail("MCP condition did not settle");
}
for (const protocol of ["legacy", "modern"] as const) {
  test(`${protocol}: notification refresh atomically replaces the tool catalog`, async () => {
    const fixture = await startMcpFixture({ protocol, transport: "http", listChanged: true });
    const { registry, service } = runtime(fixture.config);
    try {
      await service.start();
      const old = registry.snapshot();
      fixture.changeTools(["updated"]);
      await until(() => registry.definitions.some(t => t.name.includes("updated")));
      assert.equal((await old.execute(old.definitions[0]!.name, {})).status, "tool_unavailable");
      assert.equal((await registry.execute(registry.definitions[0]!.name, {})).ok, true);
      await service.reload([{ id: "test", sourcePath: "/config", config: { ...fixture.config, enabled: false } }]);
      assert.equal(registry.definitions.length, 0);
      assert.equal(service.status()[0]?.state, "disabled");
    } finally { await service.close(); await fixture.close(); }
  });
}

test("pagination is complete, filtering uses remote names, and deny rules win", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", pages: 3 });
  const { registry, service } = runtime({ ...fixture.config, allowedTools: ["echo_0", "echo_1"], disabledTools: ["echo_1"] });
  try {
    await service.start();
    assert.equal(registry.definitions.length, 1);
    assert.match(registry.definitions[0]!.name, /echo_0/);
    assert.equal(registry.executionMode(registry.definitions[0]!.name), "sequential");
    assert.equal(fixture.requests.filter(r => r.method === "tools/list").length, 3);
  } finally { await service.close(); await fixture.close(); }
});

test("unbounded pagination fails without publishing a partial catalog", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", pages: 70 });
  const { registry, service } = runtime(fixture.config);
  try {
    await service.start();
    assert.equal(registry.definitions.length, 0);
    assert.equal(service.status()[0]?.state, "failed");
    assert.equal(fixture.requests.filter(r => r.method === "tools/list").length, 64);
  } finally { await service.close(); await fixture.close(); }
});

for (const failure of ["cancel", "timeout", "disconnect"] as const) {
  test(`${failure}: only connection failures receive bounded replay`, async () => {
    const fixture = await startMcpFixture({ protocol: "modern", transport: "http", callDelayMs: 1000, dropCall: failure === "disconnect" });
    const { registry, service } = runtime({ ...fixture.config, toolTimeoutMs: 100 });
    try {
      await service.start();
      const controller = new AbortController();
      const call = registry.execute(registry.definitions[0]!.name, {}, { signal: controller.signal, isCancelled: () => controller.signal.aborted, cancellationReason: "cancel" });
      await until(() => fixture.calls() >= 1);
      if (failure === "cancel") controller.abort();
      const result = await call;
      assert.equal(result.ok, false);
      assert.equal(result.status, failure === "cancel" ? "cancelled" : failure === "timeout" ? "timeout" : "failed");
      assert.equal(fixture.calls(), failure === "disconnect" ? 2 : 1);
      assert.match(result.error ?? "", /do not automatically replay/);
      if (failure === "disconnect") { assert.equal(service.status()[0]?.state, "failed"); assert.equal(registry.definitions.length, 0); }
    } finally { await service.close(); await fixture.close(); }
  });
}

test("closing during startup aborts discovery and cannot publish a late catalog", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", hangList: true });
  const { registry, service } = runtime(fixture.config);
  try {
    const started = service.start();
    await until(() => fixture.requests.some(r => r.method === "tools/list"));
    await service.close(); await started; await service.close();
    assert.equal(registry.definitions.length, 0);
    assert.equal(service.status()[0]?.state, "closed");
  } finally { await service.close(); await fixture.close(); }
});

test("concurrent failed calls share one reconnect and each returns one final result", { timeout: 5000 }, async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", dropFirstBatch: 2 });
  const { registry, service } = runtime(fixture.config);
  try {
    await service.start();
    const view = registry.snapshot();
    const name = view.definitions[0]!.name;
    const first = view.execute(name, { value: 1 });
    await until(() => fixture.calls() === 1);
    assert.equal(fixture.requests.filter(r => r.method === "tools/list").length, 1);
    const results = await Promise.all([first, view.execute(name, { value: 2 })]);
    assert.ok(results.every(result => result.ok), JSON.stringify({ results, requests: fixture.requests }));
    assert.equal(fixture.calls(), 4);
    assert.equal(fixture.requests.filter(r => r.method === "tools/list").length, 2);
    assert.equal(service.status()[0]?.state, "ready");
    assert.equal((await view.execute(name, {})).status, "tool_unavailable");
  } finally { await service.close(); await fixture.close(); }
});

test("catalog admission rejects excessive count/bytes and retains the prior complete catalog on refresh", async () => {
  assert.throws(() => validateCatalogSize(Array.from({ length: MCP_MAX_TOOLS + 1 }, () => ({}))), /limits/);
  assert.throws(() => validateCatalogSize(["x".repeat(MCP_MAX_CATALOG_BYTES)]), /limits/);
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", listChanged: true });
  const { registry, service } = runtime(fixture.config);
  try {
    await service.start();
    const old = registry.definitions[0]!;
    fixture.changeTools(Array.from({ length: MCP_MAX_TOOLS + 1 }, (_, i) => `tool_${i}`));
    await until(() => !!service.status()[0]?.error?.includes("refresh failed"));
    assert.deepEqual(registry.definitions, [old]);
    assert.equal(service.status()[0]?.state, "ready");
  } finally { await service.close(); await fixture.close(); }
});

test("removed and re-added names get a new binding while unchanged reconnects preserve it", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", listChanged: true });
  const { registry, service } = runtime(fixture.config);
  try {
    await service.start();
    const before = registry.definitions[0]!.catalog!.binding;
    await service.reconnect("test");
    assert.equal(registry.definitions[0]!.catalog!.binding, before);
    fixture.changeTools([]);
    await until(() => registry.definitions.length === 0);
    fixture.changeTools(["echo"]);
    await until(() => registry.definitions.length === 1);
    const readded = registry.definitions[0]!.catalog!.binding;
    assert.notEqual(readded, before);
    await service.reload([]);
    await service.reload([{ id: "test", sourcePath: "/config", config: fixture.config }]);
    assert.notEqual(registry.definitions[0]!.catalog!.binding, readded);
  } finally { await service.close(); await fixture.close(); }
});

test("disabling a server during an active call cancels its logical lifetime without replay", async () => {
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http", callDelayMs: 1000 });
  const { registry, service } = runtime(fixture.config);
  try {
    await service.start();
    const call = registry.execute(registry.definitions[0]!.name, {});
    await until(() => fixture.calls() === 1);
    await service.reload([{ id: "test", sourcePath: "/config", config: { ...fixture.config, enabled: false } }]);
    assert.equal((await call).ok, false);
    assert.equal(fixture.calls(), 1);
    assert.equal(registry.definitions.length, 0);
  } finally { await service.close(); await fixture.close(); }
});
