import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { safeFixturePath } from "./verifier.ts";
// Consume a one-use completion token before importing untrusted code. It is absent
// from argv, environment and mounted files, so exit(0) cannot forge completion.
let completionToken = "";
for await (const chunk of process.stdin) completionToken += String(chunk);
Object.freeze(assert);
const check = JSON.parse(
  readFileSync(process.argv[2] ?? "/control/check.json", "utf8"),
) as { path: string; assertions: string };
// Construct trusted code before the artifact can replace global constructors.
const verify = new Function(
  "mod",
  "assert",
  `return (async () => { ${check.assertions}\n })();`,
) as (module: unknown, assertion: typeof assert) => Promise<void>;
// Dynamic import is required: the module under test is an untrusted run artifact.
const mod: unknown = await import(
  pathToFileURL(safeFixturePath("/workspace", check.path)).href
);
await verify(mod, assert);
process.stdout.write(`verified:${completionToken}\n`);
