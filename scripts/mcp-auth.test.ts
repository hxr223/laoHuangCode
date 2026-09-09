import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthCallback } from "../packages/core/mcp/src/auth/callback.ts";
import { McpOAuthProvider } from "../packages/core/mcp/src/auth/provider.ts";
import { createMcpService } from "../packages/core/mcp/src/index.ts";
import { ToolRegistry } from "../packages/core/tools/src/index.ts";
import { startOAuthFixture } from "./helpers/mcp-oauth-fixture.ts";

for (const [transport, preRegistered] of [["http", false], ["http", true], ["sse", false]] as const) {
  test(`SDK OAuth login, PKCE, issuer, refresh and logout (${transport}, pre-registered: ${preRegistered})`, async () => {
    const fixture = await startOAuthFixture({ transport });
    const data = new Map<string, unknown>();
    const registry = new ToolRegistry([]);
    const statuses: string[] = [];
    const service = createMcpService({ servers: [{ id: "test", sourcePath: "/project/mcp.json", config: {
      ...fixture.config, auth: { type: "oauth", ...(preRegistered ? { clientId: "pre-client" } : {}), scopes: ["tools"] },
    } }], projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
    credentials: { read: async k => data.get(k), write: async (k, v) => { data.set(k, structuredClone(v)); }, remove: async k => { data.delete(k); } },
    onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: s => { statuses.push(JSON.stringify(s)); } });
    let browser: Promise<Response> | undefined;
    try {
      await service.start();
      assert.equal(service.status()[0]?.state, "auth_required");
      await service.login("test", url => { browser = fetch(url); void browser.catch(() => {}); });
      await browser;
      assert.equal(service.status()[0]?.state, "ready", JSON.stringify(service.status()));
      assert.ok(fixture.scope().includes("tools"));
      assert.equal(fixture.counts().exchanges, 1);
      if (preRegistered) assert.equal(fixture.counts().registrations, 0);
      fixture.expireAccess();
      const results = await Promise.all([registry.execute(registry.definitions[0]!.name, {}), registry.execute(registry.definitions[0]!.name, {})]);
      assert.ok(results.every(result => result.ok), JSON.stringify(results));
      assert.equal(fixture.counts().refreshes, 1);
      await service.logout("test");
      assert.equal(registry.definitions.length, 1);
      assert.equal(registry.definitions[0]?.catalog?.originalName, "authenticate");
      assert.equal(data.size, 0);
      assert.ok(statuses.every(value => !/fixture-access|fixture-refresh|fixture-code|code_verifier/.test(value)));
    } finally { await service.close(); await fixture.close(); }
  });
}

test("SDK rejects a callback from a different issuer before exchanging the code", async () => {
  const fixture = await startOAuthFixture({ wrongIssuer: true });
  const data = new Map<string, unknown>();
  const service = createMcpService({ servers: [{ id: "test", sourcePath: "/config", config: fixture.config }],
    projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
    credentials: { read: async k => data.get(k), write: async (k, v) => { data.set(k, v); }, remove: async k => { data.delete(k); } },
    onToolsChanged: () => {}, onStatus: () => {} });
  let browser: Promise<Response> | undefined;
  try {
    await service.login("test", url => { browser = fetch(url); void browser.catch(() => {}); });
    await browser;
    assert.notEqual(service.status()[0]?.state, "ready");
    assert.equal(fixture.counts().exchanges, 0);
  } finally { await service.close(); await fixture.close(); }
});

test("callback rejects bad state and preserves the complete accepted response", async () => {
  const callback = await createOAuthCallback({ state: "expected", timeoutMs: 2000 });
  try {
    const bad = new URL(callback.redirectUrl);
    bad.search = "code=fake&state=wrong";
    assert.equal((await fetch(bad)).status, 400);
    const good = new URL(callback.redirectUrl);
    good.search = "code=fake&state=expected&iss=https%3A%2F%2Fissuer.test";
    assert.equal((await fetch(good)).status, 200);
    assert.equal((await callback.response).get("iss"), "https://issuer.test");
  } finally { await callback.close(); }
});

test("callback cancellation ends the wait and closes the listener", async () => {
  const controller = new AbortController();
  const callback = await createOAuthCallback({ state: "expected", timeoutMs: 2000, signal: controller.signal });
  controller.abort();
  await assert.rejects(callback.response);
  await callback.close();
  await assert.rejects(fetch(callback.redirectUrl));
});

test("callback deadline ends the wait and closes the listener", async () => {
  const callback = await createOAuthCallback({ state: "expected", timeoutMs: 20 });
  await assert.rejects(callback.response, /timed out/);
  await callback.close();
  await assert.rejects(fetch(callback.redirectUrl));
});

for (const failure of ["registration", "authorization"] as const) {
  test(`rejected ${failure} never produces tools or exchanges a code`, async () => {
    const fixture = await startOAuthFixture({ rejectRegistration: failure === "registration", rejectAuthorization: failure === "authorization" });
    const data = new Map<string, unknown>();
    const service = createMcpService({ servers: [{ id: "test", sourcePath: "/config", config: fixture.config }],
      projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
      credentials: { read: async k => data.get(k), write: async (k, v) => { data.set(k, v); }, remove: async k => { data.delete(k); } },
      onToolsChanged: () => {}, onStatus: () => {} });
    let browser: Promise<Response> | undefined;
    try {
      await service.login("test", url => { browser = fetch(url); void browser.catch(() => {}); });
      await browser;
      assert.equal(service.status()[0]?.state, "failed");
      assert.equal(service.status()[0]?.toolCount, 0);
      assert.equal(fixture.counts().exchanges, 0);
      if (failure === "registration") assert.match(service.status()[0]?.error ?? "", /clientId/);
    } finally { await service.close(); await fixture.close(); }
  });
}

test("OAuth tokens are isolated by source and issuer and logout invalidates late saves", async () => {
  const data = new Map<string, unknown>();
  const store = { read: async (key: string) => data.get(key), write: async (key: string, value: unknown) => { data.set(key, value); }, remove: async (key: string) => { data.delete(key); } };
  const one = new McpOAuthProvider({ identity: "source-one", store, config: { type: "oauth" }, env: {} });
  await one.saveTokens({ access_token: "one", token_type: "Bearer" }, { issuer: "https://a.test" });
  await one.saveTokens({ access_token: "two", token_type: "Bearer" }, { issuer: "https://b.test" });
  assert.equal((await one.tokens())?.access_token, "two");
  assert.equal((await one.tokens({ issuer: "https://a.test" }))?.access_token, "one");
  const other = new McpOAuthProvider({ identity: "source-two", store, config: { type: "oauth" }, env: {} });
  assert.equal(await other.tokens({ issuer: "https://a.test" }), undefined);
  await one.logout();
  await assert.rejects(one.saveTokens({ access_token: "late", token_type: "Bearer" }, { issuer: "https://a.test" }));
  const fresh = new McpOAuthProvider({ identity: "source-one", store, config: { type: "oauth" }, env: {} });
  assert.equal(await fresh.tokens(), undefined);
});

test("synthetic authentication shows URL immediately, shares manual login and replaces itself", async () => {
  const fixture = await startOAuthFixture();
  const registry = new ToolRegistry([]);
  const data = new Map<string, unknown>();
  let announce!: (url: string) => void;
  const announced = new Promise<string>(resolve => { announce = resolve; });
  const service = createMcpService({ servers: [{ id: "test", sourcePath: "/config", config: fixture.config }],
    projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
    credentials: { read: async k => data.get(k), write: async (k, v) => { data.set(k, v); }, remove: async k => { data.delete(k); } },
    onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: () => {},
    onAuthorization: ({ url, expiresAt }) => { assert.ok(expiresAt > Date.now()); announce(url); } });
  try {
    await service.start();
    const synthetic = registry.definitions[0]!;
    assert.equal(synthetic.catalog?.originalName, "authenticate");
    let completed = false;
    const result = registry.execute(synthetic.name, {}).then(value => { completed = true; return value; });
    const url = await announced;
    assert.equal(completed, false);
    const manual = service.login("test", shown => assert.equal(shown, url));
    await fetch(url);
    const outcome = await result;
    assert.equal(outcome.ok, true);
    assert.equal((await manual).ok, true);
    assert.equal(fixture.counts().exchanges, 1);
    assert.equal(registry.definitions[0]?.catalog?.originalName, "echo");
    assert.ok(!JSON.stringify(outcome).includes(url));
    assert.equal((await registry.execute(registry.definitions[0]!.name, {})).ok, true);
  } finally { await service.close(); await fixture.close(); }
});
