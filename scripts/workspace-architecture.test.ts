import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly workspaces?: readonly string[];
  readonly exports?: Record<string, unknown>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function listDirectories(path: string): string[] {
  const absolute = join(repositoryRoot, path);
  if (!existsSync(absolute)) {
    return [];
  }
  return readdirSync(absolute)
    .filter((entry) => statSync(join(absolute, entry)).isDirectory())
    .sort();
}

function listPackageRoots(path: string): string[] {
  return listDirectories(path).flatMap((domain) =>
    listDirectories(join(path, domain)).map((name) =>
      join(repositoryRoot, path, domain, name),
    ),
  );
}

function readManifest(packageRoot: string): Manifest {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

function isInside(path: string, root: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (!candidate.startsWith("..") && !resolve(candidate).startsWith(".."));
}

function productionRoots(): string[] {
  return [
    join(repositoryRoot, "apps", "cli"),
    ...listPackageRoots("packages"),
  ];
}

function ownerRoot(file: string): string | null {
  return productionRoots()
    .filter((root) => isInside(file, root))
    .sort((left, right) => right.length - left.length)[0] ?? null;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        if (entry !== "dist" && entry !== ".build") {
          visit(absolute);
        }
      } else if (absolute.endsWith(".ts")) {
        files.push(absolute);
      }
    }
  };
  visit(join(root, "src"));
  return files.sort();
}

function importSpecifiers(file: string): string[] {
  const content = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"'`]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      specifiers.push(match[1]!);
    }
  }
  return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  if (existsSync(base)) {
    return base;
  }
  if (existsSync(`${base}.ts`)) {
    return `${base}.ts`;
  }
  if (existsSync(join(base, "index.ts"))) {
    return join(base, "index.ts");
  }
  return base;
}

function findCrossPackageRelativeImports(): string[] {
  const violations: string[] = [];
  for (const root of productionRoots()) {
    for (const file of sourceFiles(root)) {
      const owner = ownerRoot(file);
      assert.notEqual(owner, null, file);
      for (const specifier of importSpecifiers(file)) {
        if (!specifier.startsWith(".")) {
          continue;
        }
        const target = resolveRelativeImport(file, specifier);
        if (!isInside(target, owner!)) {
          violations.push(
            `${relative(repositoryRoot, file)} -> ${specifier} (${relative(repositoryRoot, target)})`,
          );
        }
      }
    }
  }
  return violations.sort();
}

function findDeepWorkspaceImports(): string[] {
  const violations: string[] = [];
  for (const root of productionRoots()) {
    for (const file of sourceFiles(root)) {
      for (const specifier of importSpecifiers(file)) {
        if (
          specifier.startsWith("@laohuang/") &&
          (specifier.includes("/src/") || specifier.includes("/dist/"))
        ) {
          violations.push(`${relative(repositoryRoot, file)} -> ${specifier}`);
        }
      }
    }
  }
  return violations.sort();
}

function workspaceManifestRoots(): Map<string, string> {
  const roots = new Map<string, string>();
  const appRoot = join(repositoryRoot, "apps", "cli");
  const appManifest = readManifest(appRoot);
  if (appManifest.name) {
    roots.set(appManifest.name, appRoot);
  }
  for (const packageRoot of listPackageRoots("packages")) {
    const manifest = readManifest(packageRoot);
    if (manifest.name) {
      roots.set(manifest.name, packageRoot);
    }
  }
  return roots;
}

function findWorkspaceDependencyCycles(): string[] {
  const roots = workspaceManifestRoots();
  const graph = new Map<string, string[]>();
  for (const [name, root] of roots) {
    const manifest = readManifest(root);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    graph.set(
      name,
      Object.keys(dependencies).filter((dependency) => roots.has(dependency)).sort(),
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];
  const path: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      cycles.push([...path.slice(start), name].join(" -> "));
      return;
    }
    visiting.add(name);
    path.push(name);
    for (const dependency of graph.get(name) ?? []) {
      visit(dependency);
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
  };

  for (const name of [...graph.keys()].sort()) {
    visit(name);
  }
  return cycles.sort();
}

test("workspace owns every production source through acyclic public packages", () => {
  const rootManifest = readManifest(repositoryRoot);
  assert.equal(rootManifest.private, true);
  assert.deepEqual(rootManifest.workspaces, ["apps/*", "packages/*/*"]);
  assert.deepEqual(listDirectories("apps"), ["cli"]);
  assert.equal(existsSync(join(repositoryRoot, "src")), false);

  for (const packageRoot of listPackageRoots("packages")) {
    assert.equal(existsSync(join(packageRoot, "package.json")), true);
    assert.equal(existsSync(join(packageRoot, "tsconfig.json")), true);
    assert.equal(existsSync(join(packageRoot, "src", "index.ts")), true);
    const manifest = readManifest(packageRoot);
    assert.equal(manifest.private, true);
    assert.deepEqual(Object.keys(manifest.exports ?? {}), ["."]);
  }

  assert.deepEqual(findCrossPackageRelativeImports(), []);
  assert.deepEqual(findDeepWorkspaceImports(), []);
  assert.deepEqual(findWorkspaceDependencyCycles(), []);
});

test("cli production source does not keep a hard-coded provider catalog", () => {
  const cliSource = sourceFiles(join(repositoryRoot, "apps", "cli"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  assert.equal(
    existsSync(join(repositoryRoot, "apps", "cli", "src", "model-catalog.ts")),
    false,
  );
  assert.equal(cliSource.includes("BUILTIN_PROVIDERS"), false);
  assert.equal(cliSource.includes("providerNames"), false);
  assert.equal(cliSource.includes("./model-catalog"), false);
});

test("interactive commands own no string output or numbered prompt rendering", () => {
  const commands = readFileSync(
    join(repositoryRoot, "apps", "cli", "src", "commands.ts"),
    "utf8",
  );
  const modelSelection = readFileSync(
    join(repositoryRoot, "apps", "cli", "src", "model-selection.ts"),
    "utf8",
  );
  const providerAuth = readFileSync(
    join(repositoryRoot, "apps", "cli", "src", "provider-auth.ts"),
    "utf8",
  );
  const displayActions = readFileSync(
    join(repositoryRoot, "packages", "terminal", "tui", "src", "tui", "display-actions.ts"),
    "utf8",
  );

  assert.equal(commands.includes("readonly #output"), false);
  assert.equal(commands.includes("readonly #input"), false);
  assert.equal(commands.includes("this.#output("), false);
  assert.equal(commands.includes(".padEnd("), false);
  assert.equal(modelSelection.includes("console.log"), false);
  assert.equal(modelSelection.includes("index + 1"), false);
  assert.equal(providerAuth.includes("console.log"), false);
  assert.equal(providerAuth.includes("index + 1"), false);
  assert.equal(providerAuth.includes("Select option:"), false);
  assert.equal(displayActions.includes('type: "text"'), false);
  assert.equal(displayActions.includes('type: "status"'), false);
  assert.equal(displayActions.includes('type: "error"'), false);
});
