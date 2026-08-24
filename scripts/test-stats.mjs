#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = { input: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      args.input = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseStats(output) {
  const stats = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^#\s+([a-z_]+)\s+(.+)$/.exec(line.trim());
    if (match) {
      stats.set(match[1], match[2]);
    }
  }
  return {
    tests: stats.get("tests") ?? "unknown",
    pass: stats.get("pass") ?? "unknown",
    fail: stats.get("fail") ?? "unknown",
    durationMs: stats.get("duration_ms") ?? "unknown",
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let output = "";
  let status = 0;

  if (args.input) {
    output = readFileSync(args.input, "utf8");
  } else {
    const result = spawnSync("npm", ["test"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    output = `${result.stdout}${result.stderr}`;
    status = result.status ?? 1;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }

  const stats = parseStats(output);
  console.log(
    `test stats: tests=${stats.tests} pass=${stats.pass} fail=${stats.fail} duration_ms=${stats.durationMs}`,
  );
  process.exit(status);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
