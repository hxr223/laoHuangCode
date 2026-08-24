#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr}${result.stdout}`);
  }
  return result.stdout.trim();
}

function parsePackOutput(output) {
  const jsonStart = output.indexOf("[");
  if (jsonStart === -1) {
    throw new Error(`npm pack did not return JSON: ${output}`);
  }
  const packed = JSON.parse(output.slice(jsonStart));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error(`npm pack JSON did not include a filename: ${output}`);
  }
  return filename;
}

function resolveBinName(manifest) {
  if (typeof manifest.bin === "string") {
    return manifest.name;
  }
  if (manifest.bin && typeof manifest.bin === "object") {
    const first = Object.keys(manifest.bin)[0];
    if (first) {
      return first;
    }
  }
  throw new Error("package.json does not declare a bin entry");
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");
  const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  const binName = resolveBinName(manifest);
  let tarballPath = "";
  const installDir = mkdtempSync(join(tmpdir(), "laohuang-package-smoke-"));

  try {
    if (!skipBuild) {
      run("npm", ["run", "build"]);
    }
    const filename = parsePackOutput(run("npm", ["pack", "--json"]));
    tarballPath = resolve(PROJECT_ROOT, filename);
    run("npm", ["install", tarballPath, "--ignore-scripts"], { cwd: installDir });
    const binPath = join(installDir, "node_modules", ".bin", binName);
    if (!existsSync(binPath)) {
      throw new Error(`installed package did not create ${binName} binary`);
    }
    const versionOutput = run(binPath, ["--version"], { cwd: installDir });
    if (!versionOutput.includes(manifest.version)) {
      throw new Error(`expected ${binName} --version to include ${manifest.version}, got ${versionOutput}`);
    }
    console.log(`package smoke passed: ${binName} ${manifest.version}`);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
    if (tarballPath) {
      rmSync(tarballPath, { force: true });
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
