import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../apps/cli/src/args.ts";
import { main } from "../apps/cli/src/main.ts";

test("update has a standalone grammar and rejects session argument mixtures", () => {
  assert.deepEqual(parseArgs(["update"]), { kind: "update" });
  assert.deepEqual(parseArgs(["update", "--help"]), { kind: "update-help" });
  assert.deepEqual(parseArgs(["update", "-h"]), { kind: "update-help" });
  for (const args of [
    ["update", "anything"], ["update", "--model", "test"],
    ["--model", "test", "update"], ["update", "--continue"],
    ["--continue", "update"], ["update", "--version"],
    ["update", "--help", "anything"],
  ]) assert.throws(() => parseArgs(args));
  const normal = parseArgs(["--model", "update"]);
  assert.equal(normal.kind, "run");
  assert.equal(normal.kind === "run" ? normal.args.model : null, "update");
});

test("update runs without configuration, credentials, prompts, or session state", async (t) => {
  for (const configuration of ["absent", "corrupt"] as const) {
    const home = mkdtempSync(join(tmpdir(), `laohuang-update-entry-${configuration}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const configPath = join(home, "config.json");
    if (configuration === "corrupt") {
      writeFileSync(configPath, "invalid-json");
    }
    let called = 0;
    const code = await main(["update"], {
      environ: { HOME: home, USERPROFILE: home },
      configPath,
      credentialsPath: join(home, "credentials.json"),
      modelsPath: join(home, "models.json"),
      inputFn: async () => { throw new Error("update must not prompt for model configuration"); },
      secretInputFn: async () => { throw new Error("update must not prompt for credentials"); },
      outputFn: () => {},
      updateFn: async () => { called += 1; return 17; },
    });
    assert.equal(code, 17);
    assert.equal(called, 1);
    assert.equal(existsSync(join(home, ".laohuang")), false);
    assert.deepEqual(readdirSync(home), configuration === "corrupt" ? ["config.json"] : []);
    if (configuration === "corrupt") {
      assert.equal(readFileSync(configPath, "utf8"), "invalid-json");
    } else {
      assert.equal(existsSync(configPath), false);
    }
  }
});

test("update help is offline and never calls the injected updater", async () => {
  let called = 0;
  const output: string[] = [];
  const code = await main(["update", "--help"], {
    environ: {}, outputFn: (text) => { output.push(text); },
    inputFn: async () => { throw new Error("help must not prompt"); },
    updateFn: async () => { called += 1; return 0; },
  });
  assert.equal(code, 0);
  assert.equal(called, 0);
  assert.match(output.join("\n"), /laohuang update/);
});

test("update cancellation has distinct exit codes and releases only its signal listeners", async () => {
  for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    const before = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
    assert.equal(await main(["update"], {
      environ: {}, outputFn: () => {},
      updateFn: async () => { process.emit(signal); return 0; },
    }), expected);
    assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
    assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
  }
});

test("update boundary reports rejected discovery without leaking registry credentials", async () => {
  const output: string[] = [];
  const before = process.listenerCount("SIGINT");
  const code = await main(["update"], {
    environ: {}, outputFn: (text) => { output.push(text); },
    updateFn: async () => { throw new Error("https://user:secret-password@example.test:443 _authToken=secret-token"); },
  });
  assert.equal(code, 1);
  assert.match(output.join("\n"), /failed/i);
  assert.doesNotMatch(output.join("\n"), /secret-password|secret-token/);
  assert.equal(process.listenerCount("SIGINT"), before);
});
