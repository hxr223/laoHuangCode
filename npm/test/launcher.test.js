const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const packageJson = require("../package.json");

test("package exposes the laohuang executable", () => {
  assert.equal(packageJson.bin.laohuang, "bin/laohuang.js");
  assert.equal(packageJson.engines.node, ">=18");
  assert.equal(fs.existsSync(require.resolve("../LICENSE")), true);
});

test("an explicitly configured Python runs the module with all arguments", () => {
  const calls = [];
  const { run } = require("../lib/launcher");
  const status = run(["--model", "demo", "--version"], {
    env: { LAOHUANG_PYTHON: "/custom/python" },
    spawnSync(command, arguments_, options) {
      calls.push({ command, arguments_, options });
      return { status: 7 };
    },
  });

  assert.equal(status, 7);
  assert.deepEqual(calls[0].arguments_, [
    "-m",
    "laohuangcode",
    "--model",
    "demo",
    "--version",
  ]);
  assert.equal(calls[0].command, "/custom/python");
  assert.equal(calls[0].options.stdio, "inherit");
});

test("cache directory is isolated by Python package version", () => {
  const { cacheDirectory } = require("../lib/launcher");
  const directory = cacheDirectory(
    { LAOHUANG_CACHE_HOME: "/tmp/laohuang-test" },
    "9.8.7",
  );

  assert.equal(
    directory,
    path.join("/tmp/laohuang-test", "python-9.8.7"),
  );
});
