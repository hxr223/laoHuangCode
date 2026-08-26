import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Runtime import of the TypeScript source: Node type stripping requires the
// real ".ts" extension (".js" specifiers do not resolve to ".ts" files).
import {
  ConfigManager,
  defaultConfigPath,
} from "../packages/storage/local-config/src/index.ts";

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-config-test-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("resolved profiles contain no runtime credential field", () => {
  withTempDir((directory) => {
    const manager = new ConfigManager(join(directory, "config.json"));
    manager.configure({
      name: "anthropic",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseUrl: null,
    });

    const config = manager.resolve();

    assert.deepEqual(config, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      baseUrl: null,
      profile: "anthropic",
    });
    assert.equal("apiKey" in config, false);
  });
});

test("openai profile requires an explicit model", () => {
  withTempDir((directory) => {
    const manager = new ConfigManager(join(directory, "config.json"));

    assert.throws(
      () =>
        manager.configure({
          name: "openai",
          provider: "openai",
          model: "",
          baseUrl: null,
        }),
      /model is required/,
    );
  });
});

test("user can save and resolve a deepseek profile without storing key", () => {
  withTempDir((directory) => {
    const configPath = join(directory, "config.json");
    const manager = new ConfigManager(configPath);

    manager.configure({
      name: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
    });
    const config = manager.resolve();

    assert.equal(config.provider, "deepseek");
    assert.equal(config.model, "deepseek-v4-flash");
    assert.equal(config.baseUrl, "https://api.deepseek.com");
    const persisted = readFileSync(configPath, "utf8");
    assert.equal(persisted.includes("apiKey"), false);
  });
});

test("runtime overrides take priority over saved profile", () => {
  withTempDir((directory) => {
    const manager = new ConfigManager(join(directory, "config.json"));
    manager.configure({
      name: "customized",
      provider: "deepseek",
      model: "file-model",
      baseUrl: "https://file.example/v1",
    });
    const fromCli = manager.resolve({
      model: "cli-model",
      baseUrl: "https://cli.example/v1",
    });

    assert.equal(fromCli.model, "cli-model");
    assert.equal(fromCli.baseUrl, "https://cli.example/v1");
  });
});

test("environment overrides profile, model, base url, and config path", () => {
  withTempDir((directory) => {
    const configPath = join(directory, "chosen.json");
    const xdgRoot = join(directory, "xdg");
    const manager = new ConfigManager(configPath);
    manager.configure({
      name: "default",
      provider: "deepseek",
      model: "file-model",
      baseUrl: "https://file.example/v1",
    });
    manager.configure({
      name: "alternate",
      provider: "openai",
      model: "stored-openai",
      baseUrl: null,
    });

    const config = manager.resolve({
      environ: {
        LAOHUANG_PROFILE: "alternate",
        LAOHUANG_MODEL: "env-model",
        LAOHUANG_BASE_URL: "https://env.example/v1",
      },
    });

    assert.equal(config.profile, "alternate");
    assert.equal(config.provider, "openai");
    assert.equal(config.model, "env-model");
    assert.equal(config.baseUrl, "https://env.example/v1");
    assert.equal(
      defaultConfigPath({ LAOHUANG_CONFIG: configPath }),
      configPath,
    );
    assert.equal(
      defaultConfigPath({ XDG_CONFIG_HOME: xdgRoot }),
      join(xdgRoot, "laohuang", "config.json"),
    );
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
