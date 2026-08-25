#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const args = {
    version: "",
    packageName: "",
    attempts: 5,
    intervalMs: 10_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-name") {
      args.packageName = argv[++index];
    } else if (arg === "--attempts") {
      args.attempts = Number(argv[++index]);
    } else if (arg === "--interval-ms") {
      args.intervalMs = Number(argv[++index]);
    } else if (!args.version) {
      args.version = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function npmView(packageName, version) {
  return spawnSync("npm", ["view", `${packageName}@${version}`, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  const args = parseArgs(process.argv.slice(2));
  const packageName =
    args.packageName ||
    (manifest.private === true && manifest.name === "@laohuang/workspace"
      ? "laohuang"
      : manifest.name);
  const version = args.version || manifest.version;
  if (!packageName || !version) {
    throw new Error("package name and version are required");
  }
  if (!Number.isInteger(args.attempts) || args.attempts < 1) {
    throw new Error("--attempts must be a positive integer");
  }
  if (!Number.isFinite(args.intervalMs) || args.intervalMs < 0) {
    throw new Error("--interval-ms must be a non-negative number");
  }

  let lastOutput = "";
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const result = npmView(packageName, version);
    lastOutput = `${result.stdout}${result.stderr}`.trim();
    if (result.status === 0 && result.stdout.trim() === version) {
      console.log(`verified ${packageName}@${version}`);
      return;
    }
    if (attempt < args.attempts) {
      await sleep(args.intervalMs);
    }
  }

  throw new Error(`could not verify ${packageName}@${version}; last npm output: ${lastOutput}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
