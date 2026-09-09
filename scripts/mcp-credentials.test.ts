import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpCredentialFileStore } from "../packages/storage/local-config/src/mcp-credentials.ts";
import { McpConfigStore } from "../packages/storage/local-config/src/mcp-config.ts";

test("credential bindings stay separate and writes cannot escape the directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-store-"));
  try {
    const store = new McpCredentialFileStore(root);
    await Promise.all([store.write("../a", { token: "one" }), store.write("../b", { token: "two" })]);
    assert.deepEqual(await store.read("../a"), { token: "one" });
    assert.deepEqual(await store.read("../b"), { token: "two" });
    const files = await readdir(root);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.match(file, /^[a-f0-9]{64}\.json$/);
      if (process.platform !== "win32") assert.equal((await stat(join(root, file))).mode & 0o777, 0o600);
    }
    await store.remove("../a");
    assert.equal(await store.read("../a"), undefined);
    await assert.rejects(store.write("../b", undefined));
    assert.deepEqual(await store.read("../b"), { token: "two" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config storage reports corruption without echoing contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-config-"));
  try {
    const path = join(root, "mcp.json");
    const store = new McpConfigStore(path);
    assert.equal(await store.read(), undefined);
    await store.write({ version: 1, servers: {} });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, servers: {} });
    await writeFile(path, "private-secret-invalid-json");
    await assert.rejects(store.read(), error => error instanceof Error && !error.message.includes("private-secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
