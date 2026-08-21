import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Runtime import of the TypeScript source: Node type stripping requires the
// real ".ts" extension (".js" specifiers do not resolve to ".ts" files).
import { CredentialStore } from "../src/credentials.ts";

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-credentials-test-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("api key is persisted in a private credentials file", () => {
  withTempDir((directory) => {
    const path = join(directory, "laohuang", "credentials.json");

    new CredentialStore(path).set("deepseek", "secret-key");

    assert.equal(new CredentialStore(path).get("deepseek"), "secret-key");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("user can list and remove provider credentials", () => {
  withTempDir((directory) => {
    const store = new CredentialStore(join(directory, "credentials.json"));
    store.set("deepseek", "deepseek-key");
    store.set("openai", "openai-key");

    const removed = store.remove("deepseek");

    assert.equal(removed, true);
    assert.deepEqual(store.providers(), ["openai"]);
    assert.equal(store.get("deepseek"), null);
    assert.equal(store.remove("deepseek"), false);
  });
});
