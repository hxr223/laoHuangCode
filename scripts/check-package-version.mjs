#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appRoot = join(repositoryRoot, "apps", "cli");
const appManifestPath = join(appRoot, "package.json");

function parseArgs(argv) {
  const args = { packageJson: appManifestPath };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-json") {
      args.packageJson = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseStableVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`version must be a stable X.Y.Z release, got ${version}`);
  }
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function npmView(args) {
  return spawnSync("npm", ["view", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packagePath = resolve(args.packageJson);
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${packagePath} is missing package name`);
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${packagePath} is missing package version`);
  }

  const current = parseStableVersion(version);
  const exact = npmView([`${name}@${version}`, "version"]);
  if (exact.status === 0 && exact.stdout.trim() === version) {
    throw new Error(`${name}@${version} is already published`);
  }

  const latest = npmView([name, "version"]);
  if (latest.status === 0 && latest.stdout.trim().length > 0) {
    const latestVersion = latest.stdout.trim().split(/\s+/).at(-1);
    const latestParts = parseStableVersion(latestVersion);
    if (compareVersions(current, latestParts) <= 0) {
      throw new Error(`${name}@${version} must be greater than latest ${latestVersion}`);
    }
  }

  console.log(`${name}@${version} is publishable`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
