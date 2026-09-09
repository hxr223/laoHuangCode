import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { compareStableVersions } from "./update.ts";

export interface NpmRunner {
  run(args: readonly string[], options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

export interface NpmInstallation {
  readonly packageRoot: string;
  readonly installedVersion: string;
  readonly workingDirectory: string;
  readonly npm: NpmRunner;
  readonly installArgs: readonly string[];
  readonly lockPath: string;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
async function json(path: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, "utf8")));
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Launch the actual npm JS entry without a shell; bounded output never reaches the terminal directly. */
export interface NpmProcessOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnTaskkill?: (pid: number) => ChildProcess;
}

export function createNpmRunner(cliPath: string, environ: NodeJS.ProcessEnv, options: NpmProcessOptions = {}): NpmRunner {
  const platform = options.platform ?? process.platform;
  const env = { ...environ };
  for (const key of Object.keys(env)) {
    if (/^npm_config_(global|workspace|workspaces|location|package_lock|save|save_dev|save_prod|save_optional|save_peer)$/i.test(key)) delete env[key];
  }
  return {
    run(args, { cwd, timeoutMs, signal }) {
      return new Promise((resolveRun, reject) => {
        if (signal?.aborted) { reject(new Error("Update cancelled")); return; }
        const child = spawn(process.execPath, [cliPath, ...args], {
          cwd, env, shell: false, detached: platform !== "win32", windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let failure: Error | undefined;
        let stopping: Promise<void> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = (reason: string): void => {
          if (stopping) return;
          failure = new Error(reason);
          stopping = new Promise<void>((done) => {
            if (!child.pid) { done(); return; }
            if (platform === "win32") {
              const fallback = (): void => {
                failure = new Error(`${reason}; process tree cleanup failed`);
                // taskkill may fail or time out while npm is still running. Do not
                // settle until npm closes; killing its leader is only a fallback.
                try { child.kill("SIGKILL"); } catch { /* Retain the cleanup failure. */ }
                done();
              };
              try {
                const killer = options.spawnTaskkill?.(child.pid) ?? spawn(win32.join(environ.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
                killer.once("error", fallback);
                killer.once("close", (code) => { if (code !== 0) fallback(); else done(); });
              } catch { fallback(); }
            } else {
              try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = new Error(`${reason}; process group cleanup failed`);
              }
              killTimer = setTimeout(() => {
                try { process.kill(-child.pid!, "SIGKILL"); } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = new Error(`${reason}; process group cleanup failed`);
                }
                done();
              }, 200);
            }
          });
        };
        const abort = (): void => stop("Update cancelled");
        const timer = setTimeout(() => stop("npm operation timed out"), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(0, 65_536); });
        child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 65_536); });
        child.once("error", (error) => { failure = error; });
        child.once("close", async (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          await stopping;
          if (killTimer) clearTimeout(killTimer);
          if (failure) reject(failure);
          else resolveRun({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

async function npmCandidates(environ: NodeJS.ProcessEnv): Promise<string[]> {
  const paths = [environ.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  for (const directory of (environ.PATH ?? environ.Path ?? "").split(delimiter).filter(Boolean)) {
    paths.push(join(directory, "npm"), join(directory, "node_modules/npm/bin/npm-cli.js"));
  }
  const result = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    try {
      const actual = await realpath(path);
      if (basename(actual) !== "npm-cli.js") continue;
      const manifest = await json(join(dirname(actual), "../package.json"));
      if (manifest.name === "npm") result.add(actual);
    } catch { /* Missing PATH entries are expected. */ }
  }
  return [...result];
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export interface NpmDiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly cliPaths?: readonly string[];
  readonly createRunner?: (cliPath: string, environ: NodeJS.ProcessEnv) => NpmRunner;
}

export async function resolveNpmInstallation(entryPath: string, environ: NodeJS.ProcessEnv, options: NpmDiscoveryOptions = {}): Promise<NpmInstallation> {
  options.signal?.throwIfAborted();
  const entry = await realpath(entryPath);
  let packageRoot = dirname(entry);
  let manifest: JsonObject = {};
  while (true) {
    if (await exists(join(packageRoot, "package.json"))) {
      manifest = await json(join(packageRoot, "package.json"));
      break;
    }
    const parent = dirname(packageRoot);
    if (parent === packageRoot) throw new Error("Cannot locate installed laohuang package");
    packageRoot = parent;
  }
  if (manifest.name !== "laohuang" || typeof manifest.version !== "string") throw new Error("Entry does not belong to laohuang");
  compareStableVersions(manifest.version, manifest.version);
  const bin = typeof manifest.bin === "string" ? manifest.bin : object(manifest.bin).laohuang;
  if (typeof bin !== "string" || await realpath(resolve(packageRoot, bin)) !== entry) throw new Error("Entry does not match the installed laohuang executable");
  if (basename(dirname(packageRoot)) !== "node_modules" || packageRoot.split(sep).some(part => ["_npx", ".pnpm", ".yarn"].includes(part))) throw new Error("Update requires a direct npm installation; source, linked, cache and other package-manager installations are unsupported");
  const candidates = options.cliPaths ?? await npmCandidates(environ);
  const runner = options.createRunner ?? createNpmRunner;
  if (candidates.length === 0) throw new Error("Cannot locate npm-cli.js");
  const globals: NpmInstallation[] = [];
  for (const cli of candidates) {
    const npm = runner(cli, environ);
    try {
      options.signal?.throwIfAborted();
      const reported = await npm.run(["root", "--global"], { cwd: dirname(packageRoot), timeoutMs: 10_000, signal: options.signal });
      if (reported.code !== 0 || await realpath(reported.stdout.trim()) !== dirname(packageRoot)) continue;
      const prefixResult = await npm.run(["prefix", "--global"], { cwd: dirname(packageRoot), timeoutMs: 10_000, signal: options.signal });
      if (prefixResult.code !== 0) continue;
      const prefix = await realpath(prefixResult.stdout.trim());
      const checked = await npm.run(["root", "--global", "--prefix", prefix], { cwd: dirname(packageRoot), timeoutMs: 10_000, signal: options.signal });
      if (checked.code !== 0 || await realpath(checked.stdout.trim()) !== dirname(packageRoot)) continue;
      globals.push({ packageRoot, installedVersion: manifest.version, npm: {
        run: (args, runOptions) => npm.run(args[0] === "view" ? [...args, "--global", "--prefix", prefix] : args, runOptions),
      }, workingDirectory: prefix, installArgs: ["--global", "--prefix", prefix], lockPath: join(dirname(packageRoot), ".laohuang-update.lock") });
    } catch { options.signal?.throwIfAborted(); /* Try other installed npm binaries, then local ownership. */ }
  }
  if (globals.length) {
    if (new Set(globals.map(value => value.workingDirectory)).size > 1) throw new Error("Ambiguous npm global installation");
    return globals[0]!;
  }
  const owners: NpmInstallation[] = [];
  for (let root = dirname(dirname(packageRoot)); ; root = dirname(root)) {
    options.signal?.throwIfAborted();
    const lockPath = join(root, "package-lock.json");
    if (await exists(lockPath)) {
      for (const other of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]) {
        if (await exists(join(root, other))) throw new Error("Ambiguous or unsupported package manager ownership");
      }
      const rootManifest = await json(join(root, "package.json"));
      if (typeof rootManifest.packageManager === "string" && !rootManifest.packageManager.startsWith("npm@")) throw new Error("Installation belongs to another package manager");
      const lock = await json(lockPath);
      const packages = object(lock.packages);
      const installed = object(packages[relative(root, packageRoot).split(sep).join("/")]);
      if (installed.version !== manifest.version || installed.link === true || typeof installed.resolved !== "string" || !/^https?:\/\//.test(installed.resolved)) throw new Error("npm lockfile does not identify the running installation");
      const workspacePaths = new Set<string>();
      if (rootManifest.workspaces !== undefined) {
        const queried = await runner(candidates[0]!, environ).run(["query", ".workspace", "--json", "--global=false", "--prefix", root], { cwd: root, timeoutMs: 10_000, signal: options.signal });
        if (queried.code !== 0) throw new Error("npm could not verify workspace ownership");
        let workspaces: unknown;
        try { workspaces = JSON.parse(queried.stdout); } catch { throw new Error("npm returned invalid workspace metadata"); }
        if (!Array.isArray(workspaces)) throw new Error("npm returned invalid workspace metadata");
        for (const value of workspaces) {
          const workspace = object(value);
          if (typeof workspace.location !== "string" || typeof workspace.realpath !== "string" || !inside(root, resolve(root, workspace.location))) throw new Error("npm returned invalid workspace ownership");
          if (await realpath(resolve(root, workspace.location)) !== workspace.realpath) throw new Error("npm workspace target changed");
          workspacePaths.add(workspace.location);
        }
      }
      for (const [key, metadata] of Object.entries(packages)) {
        if (key.includes("node_modules") || !inside(root, resolve(root, key))) continue;
        if (key !== "") {
          if (!workspacePaths.has(key)) continue;
          if (!Object.values(packages).some(value => object(value).link === true && object(value).resolved === key)) continue;
        }
        const owner = await realpath(resolve(root, key));
        if (!inside(root, owner)) continue;
        const declaration = await json(join(owner, "package.json"));
        for (const bucket of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
          const range = object(declaration[bucket]).laohuang;
          if (typeof range !== "string") continue;
          let resolvedPackage: string | undefined;
          for (let directory = owner; inside(root, directory); directory = dirname(directory)) {
            if (await exists(join(directory, "node_modules/laohuang"))) { resolvedPackage = await realpath(join(directory, "node_modules/laohuang")); break; }
            if (directory === root) break;
          }
          if (resolvedPackage !== packageRoot) continue;
          if (object(object(metadata)[bucket]).laohuang !== range || !/^[~^]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(range) || range.includes("\n")) throw new Error("Dependency declaration is not a supported stable npm range");
          if (object(declaration.peerDependencies).laohuang !== undefined) throw new Error("Combined peer dependency ownership is unsupported");
          const npm = runner(candidates[0]!, environ);
          owners.push({ packageRoot, installedVersion: manifest.version, npm: {
            run: (args, runOptions) => npm.run(args[0] === "view" ? [...args, "--global=false", "--prefix", root, "--workspaces=false"] : args, runOptions),
          }, workingDirectory: root,
            installArgs: ["--global=false", "--prefix", root, "--package-lock=true", "--save=true", "--save-peer=false", "--save-dev=false", "--save-optional=false", "--save-prod=false", bucket === "devDependencies" ? "--save-dev" : bucket === "optionalDependencies" ? "--save-optional" : "--save-prod", ...(bucket === "devDependencies" ? ["--include=dev"] : []), ...(/^[~^]/.test(range) ? ["--save-exact=false", `--save-prefix=${range[0]}`] : ["--save-exact"]), ...(key ? ["--workspace", key, "--include-workspace-root=false"] : ["--workspaces=false"])],
            lockPath: join(root, ".laohuang-update.lock"),
          });
        }
      }
      break;
    }
    if (dirname(root) === root) break;
  }
  if (owners.length !== 1) throw new Error(owners.length ? "Ambiguous npm dependency owners" : "No direct npm dependency owns this installation");
  return owners[0]!;
}
