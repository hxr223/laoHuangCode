import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Runtime import of the TypeScript source: Node type stripping requires the
// real ".ts" extension (".js" specifiers do not resolve to ".ts" files).
import { ConfigManager } from "../src/config.ts";
import { CredentialStore } from "../src/credentials.ts";

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-config-test-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("missing provider api key has an actionable error", () => {
  withTempDir((directory) => {
    const manager = new ConfigManager(join(directory, "config.json"));
    manager.configure({ name: "default", provider: "deepseek" });

    assert.throws(
      () =>
        manager.resolve({
          credentials: new CredentialStore(join(directory, "credentials.json")),
        }),
      /No API key configured/,
    );
  });
});

test("openai profile requires an explicit model", () => {
  withTempDir((directory) => {
    const manager = new ConfigManager(join(directory, "config.json"));

    assert.throws(
      () => manager.configure({ name: "openai", provider: "openai" }),
      /model is required/,
    );
  });
});

test("user can save and resolve a deepseek profile without storing key", () => {
  withTempDir((directory) => {
    const configPath = join(directory, "config.json");
    const manager = new ConfigManager(configPath);
    const credentials = new CredentialStore(join(directory, "credentials.json"));

    manager.configure({ name: "deepseek", provider: "deepseek" });
    credentials.set("deepseek", "deepseek-secret");
    const config = manager.resolve({ credentials });

    assert.equal(config.provider, "deepseek");
    assert.equal(config.model, "deepseek-v4-flash");
    assert.equal(config.baseUrl, "https://api.deepseek.com");
    assert.equal(config.apiKey, "deepseek-secret");
    const persisted = readFileSync(configPath, "utf8");
    assert.equal(persisted.includes("deepseek-secret"), false);
  });
});

test("runtime overrides take priority over saved profile", () => {
  withTempDir((directory) => {
    const manager = new ConfigManager(join(directory, "config.json"));
    const credentials = new CredentialStore(join(directory, "credentials.json"));
    manager.configure({
      name: "customized",
      provider: "deepseek",
      model: "file-model",
      baseUrl: "https://file.example/v1",
    });
    credentials.set("deepseek", "secret");
    const fromCli = manager.resolve({
      credentials,
      model: "cli-model",
      baseUrl: "https://cli.example/v1",
    });

    assert.equal(fromCli.model, "cli-model");
    assert.equal(fromCli.baseUrl, "https://cli.example/v1");
  });
});

test("malformed profile document has an actionable error", () => {
  withTempDir((directory) => {
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, '{"profiles": []}\n', "utf8");

    assert.throws(
      () => new ConfigManager(configPath).listProfiles(),
      /profiles must be an object/,
    );
  });
});
