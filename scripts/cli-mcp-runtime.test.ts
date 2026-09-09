import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpRuntime } from "../apps/cli/src/create-mcp-runtime.ts";
import { createMcpCommand } from "../apps/cli/src/mcp-commands.ts";
import { PlainCommandPresenter } from "../apps/cli/src/plain-command-presenter.ts";
import { ToolRegistry } from "../packages/core/tools/src/index.ts";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";
import { startOAuthFixture } from "./helpers/mcp-oauth-fixture.ts";

test("invalid startup file is skipped, reload is all-or-nothing, and commands use the live service", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-mcp-"));
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http" });
  const global = join(root, "global");
  const project = join(root, "project");
  await mkdir(global); await mkdir(join(project, ".laohuang"), { recursive: true });
  await writeFile(join(global, "mcp.json"), JSON.stringify({ version: 1, servers: { good: fixture.config } }));
  await writeFile(join(project, ".laohuang/mcp.json"), '{"secret-value":');
  const notices: string[] = [];
  const presenter = new PlainCommandPresenter({ output: value => notices.push(value), input: async () => "", secretInput: async () => "" });
  const registry = new ToolRegistry([]);
  const runtime = await createMcpRuntime({ configPath: join(global, "config.json"), projectRoot: project, version: "test", env: {}, registry, presenter });
  try {
    assert.equal(fixture.requests.length, 0);
    assert.ok(notices.some(n => n.includes("Invalid JSON")));
    assert.ok(notices.every(n => !n.includes("secret-value")));
    await runtime.prepareTools();
    assert.equal(registry.definitions.length, 1);
    await assert.rejects(runtime.reload(), /previous configuration/);
    assert.equal(registry.definitions.length, 1);
    const command = createMcpCommand(runtime, presenter);
    await command.handler?.(["status"]);
    assert.ok(notices.some(n => n.includes("good: ready")));
    await command.handler?.(["reconnect"]);
    assert.ok(notices.at(-1)?.includes("/mcp status"));
    await writeFile(join(project, ".laohuang/mcp.json"), JSON.stringify({ version: 1, servers: { good: { ...fixture.config, enabled: false } } }));
    await command.handler?.(["reload"]);
    assert.equal(registry.definitions.length, 0);
    assert.equal(runtime.service.status()[0]?.state, "disabled");
  } finally { await runtime.close(); await runtime.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
});

test("empty configuration performs no setup and exits without creating storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-mcp-"));
  const presenter = new PlainCommandPresenter({ output: () => {}, input: async () => "", secretInput: async () => "" });
  const runtime = await createMcpRuntime({ configPath: join(root, "config.json"), projectRoot: root, version: "test", env: {}, registry: new ToolRegistry([]), presenter });
  try { await runtime.start(); await runtime.prepareTools(); assert.deepEqual(runtime.service.status(), []); }
  finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

for (const stop of ["cancel", "sigint", "close"] as const) {
  test(`${stop} ends an MCP login and closes its callback`, { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-mcp-auth-"));
    const fixture = await startOAuthFixture();
    await writeFile(join(root, "mcp.json"), JSON.stringify({ version: 1, servers: { test: fixture.config } }));
    let announce!: (value: URL) => void;
    const announced = new Promise<URL>(resolve => { announce = resolve; });
    const presenter = new PlainCommandPresenter({ output: text => {
      const url = text.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/)?.[0];
      if (url) announce(new URL(url));
    }, input: async () => "", secretInput: async () => "" });
    const runtime = await createMcpRuntime({ configPath: join(root, "config.json"), projectRoot: root, version: "test", env: {}, registry: new ToolRegistry([]), presenter });
    const listeners = process.listenerCount("SIGINT");
    try {
      const login = runtime.login("test");
      const url = await announced;
      if (stop === "close") await runtime.close();
      else if (stop === "sigint") process.emit("SIGINT");
      else assert.equal(runtime.cancelAuthorization(), true);
      await login;
      assert.equal(process.listenerCount("SIGINT"), listeners);
      assert.equal(runtime.service.status()[0]?.toolCount, 0);
      await assert.rejects(fetch(url.searchParams.get("redirect_uri")!));
    } finally { await runtime.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
  });
}
