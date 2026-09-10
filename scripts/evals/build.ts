import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runProcess } from "./process.ts";
declare const __LAOHUANG_EVAL_ROOT__: string;
declare const __LAOHUANG_SOURCE_FINGERPRINT__: string;
export const REPO_ROOT =
  typeof __LAOHUANG_EVAL_ROOT__ === "string"
    ? __LAOHUANG_EVAL_ROOT__
    : fileURLToPath(new URL("../../", import.meta.url));
export const OUTPUT_ROOT = join(REPO_ROOT, ".eval-results");
export const IMAGE = "laohuang-eval:local";
function sourceFingerprint(): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (["node_modules", "dist", ".build"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") || entry.name === "package.json")
        hash.update(path.slice(REPO_ROOT.length)).update(readFileSync(path));
    }
  };
  for (const path of ["apps/cli/src", "packages", "scripts/evals"])
    walk(join(REPO_ROOT, path));
  hash.update(readFileSync(join(REPO_ROOT, "package-lock.json")));
  for (const name of ["README.md", "AGENTS.md", "package.json"])
    if (existsSync(join(REPO_ROOT, name))) hash.update(readFileSync(join(REPO_ROOT, name)));
  hash.update(readFileSync(join(REPO_ROOT, "apps/cli/dist/bin.js")));
  return hash.digest("hex");
}
export async function prepareEvaluation(): Promise<{
  image: string;
  fingerprint: string;
}> {
  const directory = join(OUTPUT_ROOT, "image");
  mkdirSync(directory, { recursive: true });
  const listed = await runProcess("git", ["ls-files", "-z"], { cwd: REPO_ROOT, timeoutMs: 5000 });
  if (listed.code !== 0) throw new Error("Cannot enumerate project fixture files");
  const files: Record<string, string> = {};
  for (const name of listed.stdout.split("\0")) {
    if (!/^(apps\/cli\/src\/|packages\/|scripts\/.*\.test\.ts$|README\.md$|AGENTS\.md$|package\.json$|tsconfig[^/]*\.json$)/u.test(name)) continue;
    if (!/\.(ts|json|md)$/u.test(name) || name.includes("node_modules/")) continue;
    const path = join(REPO_ROOT, name);
    if (existsSync(path) && lstatSync(path).isFile()) files[name] = readFileSync(path, "utf8");
  }
  // This session's shared runtime is not yet tracked, but belongs to the target source.
  files["apps/cli/src/create-session-runtime.ts"] = readFileSync(join(REPO_ROOT, "apps/cli/src/create-session-runtime.ts"), "utf8");
  writeFileSync(join(directory, "project.json"), JSON.stringify(files));
  const context = join(directory, "bundle");
  mkdirSync(join(context, "cli", "dist"), { recursive: true });
  const entries = [
    "worker",
    "tool-process",
    "gateway-main",
    "module-verifier",
    "snapshot",
  ];
  await build({
    entryPoints: entries.map((name) =>
      join(REPO_ROOT, "scripts/evals", name + ".ts"),
    ),
    outdir: context,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "koffi"],
  });
  copyFileSync(
    join(REPO_ROOT, "apps/cli/dist/bin.js"),
    join(context, "cli/dist/bin.js"),
  );
  copyFileSync(
    join(REPO_ROOT, "apps/cli/package.json"),
    join(context, "cli/package.json"),
  );
  const deps: Record<string, string> = {};
  for (const name of ["@earendil-works/pi-ai", "koffi"])
    deps[name] = (
      JSON.parse(
        readFileSync(
          join(REPO_ROOT, "node_modules", name, "package.json"),
          "utf8",
        ),
      ) as { version: string }
    ).version;
  writeFileSync(
    join(context, "package.json"),
    JSON.stringify({
      name: "laohuang-evaluation-runtime",
      private: true,
      type: "module",
      dependencies: deps,
    }),
  );
  const base = process.env.LAOHUANG_EVAL_BASE_IMAGE ?? "node:22-alpine";
  const dockerfile = `ARG BASE_IMAGE=node:22-alpine\nFROM \${BASE_IMAGE}\nRUN apk add --no-cache bash tmux inotify-tools\nWORKDIR /app\nCOPY bundle/package*.json ./\nRUN npm ci --ignore-scripts --omit=dev\nCOPY bundle/ ./\nENV LANG=C.UTF-8\n`;
  writeFileSync(join(directory, "Dockerfile"), dockerfile);
  const hash = createHash("sha256").update(base).update(dockerfile);
  const hashFiles = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules" || entry.name === "package-lock.json")
        continue;
      const p = join(root, entry.name);
      if (entry.isDirectory()) hashFiles(p);
      else hash.update(p.slice(context.length)).update(readFileSync(p));
    }
  };
  hashFiles(context);
  const fingerprint = hash.digest("hex");
  const inspect = await runProcess(
    "docker",
    [
      "image",
      "inspect",
      IMAGE,
      "--format",
      '{{index .Config.Labels "laohuang.eval.fingerprint"}}',
    ],
    { timeoutMs: 10_000 },
  );
  if (inspect.code === 0 && inspect.stdout.trim() === fingerprint) {
    writeFileSync(join(directory, "fingerprint"), fingerprint);
    writeFileSync(join(directory, "source-fingerprint"), sourceFingerprint());
    await prepareProvider();
    return { image: IMAGE, fingerprint };
  }
  const lock = await runProcess(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: context, timeoutMs: 180_000 },
  );
  if (lock.code !== 0)
    throw new Error(`Evaluation runtime lockfile failed: ${lock.stderr}`);
  const built = await runProcess(
    "docker",
    [
      "build",
      "--build-arg",
      `BASE_IMAGE=${base}`,
      "--label",
      `laohuang.eval.fingerprint=${fingerprint}`,
      "-t",
      IMAGE,
      directory,
    ],
    { timeoutMs: 600_000, maxBytes: 1024 * 1024 },
  );
  writeFileSync(join(directory, "build.log"), built.stdout + built.stderr);
  if (built.code !== 0)
    throw new Error(
      `Evaluation image build failed; see ${join(directory, "build.log")}`,
    );
  writeFileSync(join(directory, "fingerprint"), fingerprint);
  writeFileSync(join(directory, "source-fingerprint"), sourceFingerprint());
  await prepareProvider();
  return { image: IMAGE, fingerprint };
}
export function requirePreparedImage(): void {
  if (!existsSync(resolve(OUTPUT_ROOT, "image/bundle/worker.mjs")))
    throw new Error("Run npm run eval:prepare before evaluation");
  const path = join(OUTPUT_ROOT, "image/source-fingerprint");
  if (!existsSync(path) || readFileSync(path, "utf8") !== sourceFingerprint())
    throw new Error("Evaluation image is stale; run npm run eval:prepare");
  if (
    typeof __LAOHUANG_SOURCE_FINGERPRINT__ === "string" &&
    __LAOHUANG_SOURCE_FINGERPRINT__ !== sourceFingerprint()
  )
    throw new Error("Evaluation config is stale; regenerate and re-import it");
}

async function prepareProvider(): Promise<void> {
  const fingerprint = sourceFingerprint();
  const outfile = join(OUTPUT_ROOT, "providers", fingerprint, "provider.mjs");
  await build({
    entryPoints: [join(REPO_ROOT, "scripts/evals/provider.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.19",
    external: ["esbuild"],
    define: {
      __LAOHUANG_EVAL_ROOT__: JSON.stringify(REPO_ROOT),
      __LAOHUANG_SOURCE_FINGERPRINT__: JSON.stringify(fingerprint),
    },
  });
  await build({ entryPoints: [join(REPO_ROOT, "scripts/evals/judge.ts")],
    outfile: join(OUTPUT_ROOT, "providers", fingerprint, "judge.mjs"), bundle: true,
    platform: "node", format: "esm", target: "node22.19", external: ["esbuild"],
    define: { __LAOHUANG_EVAL_ROOT__: JSON.stringify(REPO_ROOT) } });
  writeFileSync(join(OUTPUT_ROOT, "image/provider-path"), outfile);
}
