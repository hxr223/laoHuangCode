import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Runtime import of the TypeScript source: Node type stripping requires the
// real ".ts" extension (".js" specifiers do not resolve to ".ts" files).
import { CredentialStore } from "../packages/storage/local-config/src/index.ts";

async function withTempDir(
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-credentials-test-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("api key is persisted in a private credentials file", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "laohuang", "credentials.json");

    await new CredentialStore(path).modify("deepseek", async () => ({
      type: "api_key",
      key: "secret-key",
    }));

    assert.deepEqual(await new CredentialStore(path).read("deepseek"), {
      type: "api_key",
      key: "secret-key",
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("user can list and remove provider credentials", async () => {
  await withTempDir(async (directory) => {
    const store = new CredentialStore(join(directory, "credentials.json"));
    await store.modify("deepseek", async () => ({
      type: "api_key",
      key: "deepseek-key",
    }));
    await store.modify("openai", async () => ({
      type: "api_key",
      key: "openai-key",
    }));

    await store.delete("deepseek");

    assert.deepEqual(await store.list(), [{
      providerId: "openai",
      type: "api_key",
    }]);
    assert.equal(await store.read("deepseek"), undefined);
    await store.delete("deepseek");
    assert.equal(await store.read("deepseek"), undefined);
  });
});

test("version one keys are read and rewritten as version two", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "credentials.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      providers: { deepseek: { api_key: "legacy-secret" } },
    }));
    const store = new CredentialStore(path);

    assert.deepEqual(await store.read("deepseek"), {
      type: "api_key",
      key: "legacy-secret",
    });
    await store.modify("deepseek", async (current) => current);

    const persisted = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      providers: Record<string, unknown>;
    };
    assert.equal(persisted.version, 2);
    assert.deepEqual(persisted.providers["deepseek"], {
      type: "api_key",
      key: "legacy-secret",
    });
  });
});

test("api key setup fields are persisted without entering ordinary config", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "credentials.json");
    const store = new CredentialStore(path);
    await store.modify("cloudflare-ai-gateway", async () => ({
      type: "api_key",
      key: "cf-secret",
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        CLOUDFLARE_GATEWAY_ID: "gateway-1",
      },
    }));

    assert.deepEqual(await store.read("cloudflare-ai-gateway"), {
      type: "api_key",
      key: "cf-secret",
      env: {
        CLOUDFLARE_ACCOUNT_ID: "account-1",
        CLOUDFLARE_GATEWAY_ID: "gateway-1",
      },
    });
    assert.deepEqual(await store.list(), [{
      providerId: "cloudflare-ai-gateway",
      type: "api_key",
    }]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test("oauth and empty api-key credentials are rejected", async () => {
  await withTempDir(async (directory) => {
    const oauthPath = join(directory, "oauth.json");
    writeFileSync(oauthPath, JSON.stringify({
      version: 2,
      providers: {
        anthropic: {
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: 1,
        },
      },
    }));
    await assert.rejects(
      new CredentialStore(oauthPath).read("anthropic"),
      /OAuth credentials are not supported/,
    );

    const emptyStore = new CredentialStore(join(directory, "empty.json"));
    await assert.rejects(
      emptyStore.modify("openai", async () => ({ type: "api_key" })),
      /API-key credential must contain a key or provider environment/,
    );
  });
});

test("credential mutations are serialized without losing providers", async () => {
  await withTempDir(async (directory) => {
    const store = new CredentialStore(join(directory, "credentials.json"));
    await Promise.all([
      store.modify("deepseek", async () => ({ type: "api_key", key: "d" })),
      store.modify("openai", async () => ({ type: "api_key", key: "o" })),
    ]);
    assert.deepEqual((await store.list()).map((item) => item.providerId), [
      "deepseek",
      "openai",
    ]);
    await store.delete("deepseek");
    assert.equal(await store.read("deepseek"), undefined);
    assert.deepEqual(await store.read("openai"), { type: "api_key", key: "o" });
  });
});
