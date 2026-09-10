import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckResult, CheckSpec, RunEvidence, Scenario } from "./types.ts";

/** Reject links in every existing component before inspecting untrusted output. */
export function safeFixturePath(root: string, name: string): string {
  if (
    isAbsolute(name) ||
    name.split(/[\\/]/u).includes("..") ||
    name.includes("\0")
  )
    throw new Error("Unsafe fixture path");
  const base = resolve(root),
    target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep))
    throw new Error("Fixture path escapes root");
  let current = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    // lstat detects dangling symlinks, unlike existsSync.
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Symlink evidence is not accepted");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
export function listFixtureFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === ".git") continue;
      const full = join(directory, name),
        stat = lstatSync(full);
      if (stat.isDirectory()) visit(full);
      else files.push(relative(root, full));
    }
  };
  visit(root);
  return files.sort();
}
export async function verifyEvidence(
  scenario: Scenario,
  evidence: RunEvidence,
  root: string,
  verifyModule?: (
    check: Extract<CheckSpec, { kind: "module" }>,
  ) => Promise<string | null>,
): Promise<CheckResult[]> {
  return Promise.all(
    scenario.checks.map(async (check): Promise<CheckResult> => {
      const name =
        check.kind +
        ("path" in check
          ? `: ${check.path}`
          : "name" in check
            ? `: ${check.name}`
            : "");
      try {
        let pass = false;
        switch (check.kind) {
          case "file-equals":
            pass =
              readFileSync(safeFixturePath(root, check.path), "utf8") ===
              check.value;
            break;
          case "file-includes":
            pass = readFileSync(
              safeFixturePath(root, check.path),
              "utf8",
            ).includes(check.value);
            break;
          case "unchanged": {
            const target = safeFixturePath(root, check.path),
              before = scenario.files[check.path];
            pass =
              before === undefined
                ? !existsSync(target)
                : readFileSync(target, "utf8") === before;
            break;
          }
          case "output-includes":
            pass = evidence.output
              .toLowerCase()
              .includes(check.value.toLowerCase());
            break;
          case "output-excludes":
            pass = !evidence.output
              .toLowerCase()
              .includes(check.value.toLowerCase());
            break;
          case "output-equals":
            pass = evidence.output.trim() === check.value;
            break;
          case "tool-used":
            pass = evidence.tools.some((tool) => tool.name === check.name);
            break;
          case "tool-not-used":
            pass = !evidence.tools.some((tool) => tool.name === check.name);
            break;
          case "tool-count-max":
            pass =
              evidence.tools.filter((tool) => tool.name === check.name)
                .length <= check.count;
            break;
          case "tool-error":
            pass = evidence.tools.some(
              (tool) => tool.name === check.name && tool.result?.ok === false,
            );
            break;
          case "tool-order": {
            let index = 0;
            for (const tool of evidence.tools)
              if (tool.name === check.names[index]) index++;
            pass = index === check.names.length;
            break;
          }
          case "event":
            pass = evidence.events.some(
              (event) =>
                event.kind === check.name &&
                Object.entries(check.match ?? {}).every(
                  ([key, value]) => event.payload[key] === value,
                ),
            );
            break;
          case "no-extra-files": {
            const allowed = new Set([
              ...Object.keys(scenario.files),
              ...check.allowed,
            ]);
            pass = listFixtureFiles(root).every((file) => allowed.has(file));
            break;
          }
          case "no-forbidden-attempt": {
            const pattern = new RegExp(check.pattern, "iu");
            pass = !evidence.tools.some((tool) => {
              const args = { ...tool.args };
              if (
                ["read", "write", "edit"].includes(tool.name) &&
                typeof args.path === "string"
              )
                args.path = resolve("/workspace", args.path);
              return (
                pattern.test(JSON.stringify(tool.args)) ||
                pattern.test(JSON.stringify(args))
              );
            });
            break;
          }
          case "module": {
            if (!verifyModule)
              throw new Error(
                "Module verification requires an isolated verifier",
              );
            safeFixturePath(root, check.path);
            const error = await verifyModule(check);
            if (error) throw new Error(error);
            pass = true;
            break;
          }
          case "tui":
            pass = evidence.checks.some(
              (result) => result.name === check.name && result.pass,
            );
            break;
        }
        return { name, pass, reason: pass ? "符合验收条件" : "不符合验收条件" };
      } catch (error) {
        return {
          name,
          pass: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}
