import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const filter = new URL("../apps/cli/src/sqlite-warning-filter.ts", import.meta.url).href;
const message = "SQLite is an experimental feature and might change at any time";

test("CLI warning filter suppresses only the uncoded SQLite experimental warning", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import ${JSON.stringify(filter)};
    process.emitWarning(${JSON.stringify(message)}, "ExperimentalWarning");
    process.emitWarning("unrelated experimental feature", "ExperimentalWarning");
    process.emitWarning(${JSON.stringify(message)}, "Warning");
    process.emitWarning(${JSON.stringify(message)}, { type: "ExperimentalWarning", code: "KEEP_ME" });
    process.stderr.write("Attachment cleanup failed: example\\n");
    process.once("probe", value => { if (value !== 42) throw new Error("lost event"); });
    if (!process.emit("probe", 42)) throw new Error("lost return value");
  `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /\) ExperimentalWarning: SQLite/);
  assert.match(result.stderr, /ExperimentalWarning: unrelated experimental feature/);
  assert.match(result.stderr, /Warning: SQLite/);
  assert.match(result.stderr, /\[KEEP_ME\] ExperimentalWarning: SQLite/);
  assert.match(result.stderr, /Attachment cleanup failed: example/);
});

test("CLI warning filter covers queued native SQLite warnings without affecting child processes", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { spawnSync } from "node:child_process";
    import { DatabaseSync } from "node:sqlite";
    import ${JSON.stringify(filter)};
    const db = new DatabaseSync(":memory:");
    db.close();
    const child = spawnSync(process.execPath, ["-e", ${JSON.stringify(`process.emitWarning(${JSON.stringify(message)}, "ExperimentalWarning")`)}], {encoding:"utf8"});
    if (child.status !== 0 || !child.stderr.includes("ExperimentalWarning: SQLite")) throw new Error("child warning was hidden");
  `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning: SQLite/);
});

test("bundled CLI startup does not display the SQLite experimental warning", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../apps/cli/dist/bin.js", import.meta.url)), "--version"], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\d+\.\d+\.\d+/);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning: SQLite/);
});
