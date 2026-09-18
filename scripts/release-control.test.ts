import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { requiresRelease, validateRecoveryMetadata } from "./release-control.mjs";

test("release control: only an explicit infrastructure allowlist skips publishing", () => {
  assert.equal(requiresRelease([".github/workflows/release.yml", "scripts/release-control.test.ts"]), false);
  for (const file of ["apps/cli/src/main.ts", "package-lock.json", "scripts/build-standalone.mjs", "packages/fs/tool-fs/src/read-image.ts", "unknown"]) {
    assert.equal(requiresRelease([".github/workflows/release.yml", file]), true);
  }
});

test("release control: workflows pin recovered assets and never publish npm on dispatch", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const standalone = readFileSync(new URL("../.github/workflows/standalone.yml", import.meta.url), "utf8");
  assert.match(release, /if: github.event_name == 'push' && needs.prepare.outputs.required == 'true'/);
  assert.match(release, /source-ref: \$\{\{ needs.prepare.outputs.sha \}\}/);
  assert.match(release, /ref: \$\{\{ needs.prepare.outputs.sha \}\}/);
  assert.match(release, /--target "\$RELEASE_SHA"/);
  assert.match(release, /needs.prepare.result == 'success'/);
  assert.match(release, /needs.standalone.result == 'success'/);
  assert.match(standalone, /ref: \$\{\{ inputs.source-ref \|\| github.sha \}\}/);
});

test("release control: recovery pins the published latest version to its exact commit", () => {
  const metadata = { version: "0.9.2", gitHead: "a".repeat(40) };
  const manifest = { name: "laohuang", version: "0.9.2" };
  assert.equal(validateRecoveryMetadata("0.9.2", metadata, "0.9.2", manifest), metadata.gitHead);
  assert.throws(() => validateRecoveryMetadata("0.9.2", metadata, "0.9.3", manifest));
  assert.throws(() => validateRecoveryMetadata("0.9.2", { ...metadata, version: "0.9.1" }, "0.9.2", manifest));
  for (const gitHead of [undefined, "main", "-x", "a".repeat(39), "a".repeat(41)]) {
    assert.throws(() => validateRecoveryMetadata("0.9.2", { ...metadata, gitHead }, "0.9.2", manifest));
  }
  for (const version of ["", "0.9.2-beta", "01.9.2", "0.9.2\ninjected=true"]) {
    assert.throws(() => validateRecoveryMetadata(version, metadata, "0.9.2", manifest));
  }
  assert.throws(() => validateRecoveryMetadata("0.9.2", metadata, "0.9.2", { ...manifest, version: "0.9.3" }));
  assert.throws(() => validateRecoveryMetadata("0.9.2", metadata, "0.9.2", { ...manifest, name: "another" }));
});
