import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-engineering-scripts-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(PROJECT_ROOT, script), ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("check-package-version verifies the package version is publishable", () => {
  withTempDir((directory) => {
    const binDir = join(directory, "bin");
    mkdirSync(binDir);
    const packageJson = join(directory, "package.json");
    writeFileSync(
      packageJson,
      JSON.stringify({ name: "laohuang", version: "1.2.3" }),
      "utf8",
    );
    writeExecutable(
      join(binDir, "npm"),
      `
const args = process.argv.slice(2);
if (args.join(" ") === "view laohuang@1.2.3 version") {
  process.exit(1);
}
if (args.join(" ") === "view laohuang version") {
  console.log("1.2.2");
  process.exit(0);
}
console.error("unexpected npm command", args.join(" "));
process.exit(2);
`,
    );

    const result = runScript(["scripts/check-package-version.mjs"].join("/"), [
      "--package-json",
      packageJson,
    ], {
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /laohuang@1\.2\.3 is publishable/);
  });
});

test("package-smoke packs, installs, and runs the published binary shape", () => {
  withTempDir((directory) => {
    const binDir = join(directory, "bin");
    mkdirSync(binDir);
    writeExecutable(
      join(binDir, "npm"),
      `
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const command = args.join(" ");
if (command === "run build") {
  process.exit(0);
}
if (command === "pack --workspace laohuang --json") {
  writeFileSync("laohuang-0.5.1.tgz", "fake tarball", "utf8");
  console.log(JSON.stringify([{ filename: "laohuang-0.5.1.tgz" }]));
  process.exit(0);
}
if (args[0] === "install") {
  const binDir = join(process.cwd(), "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const cliPath = join(binDir, "laohuang");
  writeFileSync(cliPath, "#!/usr/bin/env node\\nconsole.log('0.5.1')\\n", "utf8");
  chmodSync(cliPath, 0o755);
  process.exit(0);
}
console.error("unexpected npm command", command);
process.exit(2);
`,
    );

    const result = runScript("scripts/package-smoke.mjs", [], {
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /package smoke passed/);
    assert.equal(existsSync(join(PROJECT_ROOT, "laohuang-0.5.1.tgz")), false);
  });
});

test("terminal-smoke opens and captures a controlled tmux session", () => {
  withTempDir((directory) => {
    const binDir = join(directory, "bin");
    mkdirSync(binDir);
    const logPath = join(directory, "tmux.log");
    writeExecutable(
      join(binDir, "tmux"),
      `
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.TMUX_LOG, args.join(" ") + "\\n", "utf8");
if (args[0] === "capture-pane") {
  console.log("laohuang smoke ok");
}
`,
    );

    const result = spawnSync("bash", [join(PROJECT_ROOT, "scripts/tui-smoke.sh")], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        TMUX_LOG: logPath,
        LAOHUANG_SMOKE_SKIP_BUILD: "1",
        LAOHUANG_SMOKE_COMMAND: `${process.execPath} --version`,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /laohuang smoke ok/);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /new-session/);
    assert.match(log, /--version/);
    assert.match(log, /sleep/);
    assert.match(log, /capture-pane/);
    assert.match(log, /kill-session/);
  });
});

test("verify-published-version retries npm registry lookups until the expected version appears", () => {
  withTempDir((directory) => {
    const binDir = join(directory, "bin");
    mkdirSync(binDir);
    writeExecutable(
      join(binDir, "npm"),
      `
const args = process.argv.slice(2);
if (args.join(" ") === "view laohuang@0.5.1 version") {
  console.log("0.5.1");
  process.exit(0);
}
console.error("unexpected npm command", args.join(" "));
process.exit(2);
`,
    );

    const result = runScript(
      "scripts/verify-published-version.mjs",
      [
        "0.5.1",
        "--package-name",
        "laohuang",
        "--attempts",
        "1",
        "--interval-ms",
        "0",
      ],
      { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /verified laohuang@0\.5\.1/);
  });
});

test("test-stats summarizes saved node test output", () => {
  withTempDir((directory) => {
    const output = join(directory, "node-test-output.tap");
    writeFileSync(
      output,
      [
        "TAP version 13",
        "# tests 3",
        "# pass 3",
        "# fail 0",
        "# duration_ms 12.5",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runScript("scripts/test-stats.mjs", ["--input", output]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tests=3 pass=3 fail=0 duration_ms=12\.5/);
  });
});

test("profile-cli records a CPU profile for the CLI command", () => {
  withTempDir((directory) => {
    const binDir = join(directory, "bin");
    const outputDir = join(directory, "profiles");
    mkdirSync(binDir);
    writeExecutable(
      join(binDir, "node"),
      `
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dirArg = process.argv.find((arg) => arg.startsWith("--cpu-prof-dir="));
const profileDir = dirArg.slice("--cpu-prof-dir=".length);
mkdirSync(profileDir, { recursive: true });
writeFileSync(join(profileDir, "fake.cpuprofile"), "{}", "utf8");
console.log("profiled command");
`,
    );

    const result = runScript(
      "scripts/profile-cli.mjs",
      ["--output", outputDir, "--version"],
      { LAOHUANG_NODE_BIN: join(binDir, "node") },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fake\.cpuprofile/);
  });
});
