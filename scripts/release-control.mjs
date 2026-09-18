import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Only release orchestration changes may land without publishing a new version.
const infrastructureFiles = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  ".github/workflows/standalone.yml",
  "scripts/release-control.mjs",
  "scripts/release-control.test.ts",
  "INSTALLING.md",
]);

export function requiresRelease(files) {
  return files.some((file) => !infrastructureFiles.has(file));
}

export function validateRecoveryMetadata(version, metadata, latest, manifest) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Recovery requires a stable X.Y.Z version");
  }
  if (metadata.version !== version || latest !== version) {
    throw new Error("Recovery is restricted to the existing npm latest version");
  }
  if (typeof metadata.gitHead !== "string" || !/^[a-f0-9]{40}$/.test(metadata.gitHead)) {
    throw new Error("Published package has no valid gitHead");
  }
  if (manifest.name !== "laohuang" || manifest.version !== version) {
    throw new Error("Published commit manifest does not match the npm version");
  }
  return metadata.gitHead;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 60_000 }).trim();
}

function output(name, value) {
  console.log(`${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "changes") {
    if (!/^[a-f0-9]{40}$/.test(argument ?? "")) throw new Error("A full base commit SHA is required");
    const files = run("git", ["diff", "--no-renames", "--name-only", "-z", argument, "HEAD"]).split("\0").filter(Boolean);
    output("required", String(requiresRelease(files)));
    return;
  }
  if (command !== "recover") throw new Error("Expected changes or recover");
  if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Recovery must run from main");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(argument ?? "")) {
    throw new Error("Recovery requires a stable X.Y.Z version");
  }
  const registry = "--registry=https://registry.npmjs.org";
  const metadata = JSON.parse(run("npm", ["view", `laohuang@${argument}`, "version", "gitHead", "--json", registry]));
  const latest = run("npm", ["view", "laohuang", "dist-tags.latest", registry]);
  // Validate registry data before using gitHead as a git argument.
  validateRecoveryMetadata(argument, metadata, latest, { name: "laohuang", version: argument });
  const manifest = JSON.parse(run("git", ["show", `${metadata.gitHead}:apps/cli/package.json`]));
  const sha = validateRecoveryMetadata(argument, metadata, latest, manifest);
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const prs = JSON.parse(run("gh", ["api", `/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}/pulls`]));
  if (!prs.some((pr) => pr.merged_at && pr.base.ref === "main" && pr.merge_commit_sha === sha)) {
    throw new Error("Published commit must be a PR merge into main");
  }
  output("sha", sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
