import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../apps/cli/src/main.ts";
import { ConfigManager, CredentialStore } from "@laohuang/local-config";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";

test("real CLI composition loads MCP, handles management commands and exits without model calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cli-"));
  const fixture = await startMcpFixture({ protocol: "modern", transport: "http" });
  const configPath = join(root, "config.json");
  const credentialsPath = join(root, "credentials.json");
  new ConfigManager(configPath).configure({ name: "offline", provider: "deepseek", model: "deepseek-v4-flash" });
  await new CredentialStore(credentialsPath).modify("deepseek", async () => ({ type: "api_key", key: "offline-placeholder" }));
  await writeFile(join(root, "mcp.json"), JSON.stringify({ version: 1, servers: { local: fixture.config } }));
  const commands = ["/mcp reconnect local", "/mcp status", "/exit"];
  const output: string[] = [];
  try {
    const result = await main([], { environ: { HOME: root, USERPROFILE: root }, configPath, credentialsPath,
      inputFn: async () => commands.shift() ?? "/exit", outputFn: line => output.push(line), stdin: { isTTY: false }, stdout: { isTTY: false } });
    assert.equal(result, 0);
    assert.ok(output.some(line => /local: ready.*1 tools/.test(line)), output.join("\n"));
    assert.ok(fixture.requests.some(request => request.method === "tools/list"));
    assert.equal(fixture.calls(), 0);
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }); }
});
