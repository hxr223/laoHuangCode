import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../apps/cli/src/main.ts";
import { ConfigManager, CredentialStore } from "@laohuang/local-config";
import { resolveBashPath } from "../packages/shell/bash-local/src/index.ts";

for (const available of [true, false]) {
  test(`doctor reports configured Bash ${available ? "path" : "failure"}`, { skip: process.platform === "win32" }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "cli-bash-path-test-"));
    try {
      const shellPath = join(directory, "custom bash");
      if (available) symlinkSync(resolveBashPath(), shellPath);
      const configPath = join(directory, "config.json");
      new ConfigManager(configPath).configure({
        name: "default", provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com",
      });
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(configPath, JSON.stringify({ ...config, shell_path: shellPath }));
      const credentialsPath = join(directory, "credentials.json");
      await new CredentialStore(credentialsPath).modify("deepseek", async () => ({ type: "api_key", key: "test-only" }));
      const output: string[] = [];
      const status = await main(["doctor"], {
        configPath, credentialsPath, environ: {}, outputFn: (message) => { output.push(message); },
      });
      assert.equal(status, available ? 0 : 1);
      assert.ok(output.includes(available
        ? `Bash: ${shellPath}`
        : `Bash: Configured Bash is missing or not executable: ${shellPath}`));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
