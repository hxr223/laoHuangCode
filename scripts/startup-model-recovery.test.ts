import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigManager, CredentialStore } from "@laohuang/local-config";
import { PromptCancelledError, PromptEofError } from "@laohuang/tui";
import { main } from "../apps/cli/src/main.ts";

for (const scenario of ["model", "provider", "cancel", "interrupt", "eof", "pipe", "cli", "env"] as const) {
  test(`startup model recovery: ${scenario}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "laohuang-recovery-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    const manager = new ConfigManager(configPath);
    manager.configure({ name: "other", provider: "deepseek", model: "deepseek-v4-pro", baseUrl: null });
    manager.configure({ name: "work", provider: scenario === "provider" ? "removed" : "deepseek",
      model: "removed-model", baseUrl: "https://relay.example/v1" });
    const before = readFileSync(configPath, "utf8");
    await new CredentialStore(credentialsPath).modify("deepseek", async () => ({ type: "api_key", key: "offline-key" }));
    const output: string[] = [];
    let prompts = 0;
    const result = await main(scenario === "cli" ? ["--model", "explicit-missing"] : [], {
      configPath, credentialsPath,
      environ: { HOME: directory, USERPROFILE: directory, ...(scenario === "env" ? { LAOHUANG_MODEL: "explicit-missing" } : {}) },
      stdin: { isTTY: scenario !== "pipe" }, stdout: { isTTY: true },
      outputFn: line => output.push(line),
      secretInputFn: () => { throw new Error("Unexpected credential prompt"); },
      inputFn: () => {
        prompts++;
        if (scenario === "cancel") return "";
        if (scenario === "interrupt") throw new PromptCancelledError();
        if (scenario === "eof") throw new PromptEofError();
        if (prompts === 1) {
          const choice = output.join("\n").match(/^\s*(\d+)\. DeepSeek\b/m);
          assert.ok(choice);
          return choice[1]!;
        }
        return prompts === 2 ? "1" : "/exit";
      },
    });
    if (["pipe", "cli", "env"].includes(scenario)) {
      assert.equal(result, 2);
      assert.equal(prompts, 0);
    } else {
      assert.equal(result, 0);
      assert.ok(output.some(line => line.includes("Please reconfigure profile 'work'")));
    }
    if (scenario === "model" || scenario === "provider") {
      assert.equal(manager.resolve().model, "deepseek-v4-flash");
      assert.equal(manager.resolve().profile, "work");
      assert.equal(manager.resolve().baseUrl, scenario === "model" ? "https://relay.example/v1" : null);
      assert.equal(manager.listProfiles().find(profile => profile.name === "other")?.model, "deepseek-v4-pro");
      assert.ok(output.some(line => line.includes("ready")));
    } else {
      assert.equal(readFileSync(configPath, "utf8"), before);
    }
  });
}
