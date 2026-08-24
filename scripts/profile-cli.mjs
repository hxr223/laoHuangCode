#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const scriptArgs = separator === -1 ? argv : argv.slice(0, separator);
  const cliArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const args = {
    output: join(tmpdir(), `laohuang-cli-profile-${Date.now()}`),
    cliArgs,
  };
  for (let index = 0; index < scriptArgs.length; index += 1) {
    const arg = scriptArgs[index];
    if (arg === "--output") {
      args.output = scriptArgs[++index];
    } else {
      args.cliArgs = scriptArgs.slice(index).concat(args.cliArgs);
      break;
    }
  }
  return args;
}

function findProfiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".cpuprofile"))
    .map((entry) => join(directory, entry));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = resolve(args.output);
  mkdirSync(outputDir, { recursive: true });
  const nodeBin = process.env.LAOHUANG_NODE_BIN || process.execPath;
  const cliPath = join(PROJECT_ROOT, "dist", "cli.js");
  const cliArgs = args.cliArgs.length > 0 ? args.cliArgs : ["--version"];
  const result = spawnSync(nodeBin, ["--cpu-prof", `--cpu-prof-dir=${outputDir}`, cliPath, ...cliArgs], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  const profiles = findProfiles(outputDir);
  if (profiles.length === 0) {
    throw new Error(`no .cpuprofile file was written to ${outputDir}`);
  }
  console.log(`profile written: ${profiles[0]}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
