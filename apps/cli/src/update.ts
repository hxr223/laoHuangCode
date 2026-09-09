import { randomUUID } from "node:crypto";
import { open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { NpmInstallation } from "./update-installation.ts";

export function compareStableVersions(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string): bigint[] => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.includes("\n")) {
      throw new Error("Expected a stable three-component version");
    }
    return value.split(".").map(BigInt);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export function updateDiagnostic(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[registry URL]")
    .replace(/npm_[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/bearer\s+[^\s"']+/gi, "[redacted]")
    .replace(/["']?(?:_authToken|_auth|password|token|authorization)["']?\s*[=:]\s*["']?[^\s"',;}]+/gi, "[redacted]")
    .slice(0, 600);
}

export interface UpdateOptions {
  readonly installation: NpmInstallation;
  readonly output: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly lockIO?: UpdateLockIO;
}

export interface UpdateLockIO {
  acquire(path: string): Promise<{ writeFile(contents: string): Promise<void>; close(): Promise<void> }>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
}

const defaultLockIO: UpdateLockIO = {
  acquire: path => open(path, "wx", 0o600),
  read: path => readFile(path, "utf8"),
  remove: path => unlink(path),
};

async function installedVersion(installation: NpmInstallation): Promise<string> {
  if (await realpath(installation.packageRoot) !== installation.packageRoot) throw new Error("Installation target changed");
  const value: unknown = JSON.parse(await readFile(join(installation.packageRoot, "package.json"), "utf8"));
  if (typeof value !== "object" || value === null || !("name" in value) || value.name !== "laohuang" || !("version" in value) || typeof value.version !== "string") {
    throw new Error("Installed laohuang package is missing or invalid");
  }
  compareStableVersions(value.version, value.version);
  return value.version;
}

export async function runUpdate({ installation, output, signal, lockIO = defaultLockIO }: UpdateOptions): Promise<number> {
  const token = randomUUID();
  let ownsLock = false;
  let installing = false;
  const cancelled = (): void => { if (signal?.aborted) throw new Error("Update cancelled"); };
  try {
    cancelled();
    let lock;
    try {
      lock = await lockIO.acquire(installation.lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let details = "unreadable owner";
      try { details = updateDiagnostic(await lockIO.read(installation.lockPath)); } catch { /* Retain lock. */ }
      throw new Error(`Update lock occupied: ${installation.lockPath} (${details}). Remove it only after confirming no update process is running.`);
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, target: installation.packageRoot, token }));
      ownsLock = true;
    } catch (error) {
      // A rejected write may be partial, or the pathname may already refer to
      // another updater's file. Without a persisted token ownership is unknown.
      output(`Lock initialization failed; retained ${updateDiagnostic(installation.lockPath)}. Remove it only after confirming no update process is running.`);
      throw error;
    } finally { await lock.close(); }
    cancelled();
    const current = await installedVersion(installation);
    const queried = await installation.npm.run(["view", "laohuang@latest", "version", "--json"], {
      cwd: installation.workingDirectory, timeoutMs: 30_000, signal,
    });
    cancelled();
    if (queried.code !== 0) throw new Error(`npm version query failed: ${updateDiagnostic(queried.stderr)}`);
    let target: unknown;
    try { target = JSON.parse(queried.stdout); } catch { throw new Error("npm returned invalid version JSON"); }
    if (typeof target !== "string") throw new Error("npm returned an invalid version");
    const comparison = compareStableVersions(current, target);
    if (comparison >= 0) {
      output(comparison === 0 ? `laohuang ${current} is already up to date.` : `laohuang ${current} is newer than latest ${target}; no downgrade needed.`);
      return 0;
    }
    cancelled();
    installing = true;
    const installed = await installation.npm.run(["install", `laohuang@${target}`, ...installation.installArgs, "--include=prod", "--include=optional", "--dry-run=false", "--package-lock-only=false", "--ignore-scripts"], {
      cwd: installation.workingDirectory, timeoutMs: 600_000, signal,
    });
    cancelled();
    if (installed.code !== 0) throw new Error(`npm installation failed: ${updateDiagnostic(installed.stderr)}`);
    const actual = await installedVersion(installation);
    if (actual !== target) throw new Error(`Installed version verification failed: expected ${target}, found ${actual}`);
    output(`Updated laohuang ${current} → ${actual}. Restart laohuang to use the new version.`);
    return 0;
  } catch (error) {
    output(`${signal?.aborted ? "Update cancelled" : "Update failed"}: ${updateDiagnostic(error)}${installing ? " Installation may have changed; check the actual version or reinstall." : ""}`);
    return signal?.aborted ? 130 : 1;
  } finally {
    if (ownsLock) {
      try {
        const lock: unknown = JSON.parse(await lockIO.read(installation.lockPath));
        if (typeof lock === "object" && lock !== null && "token" in lock && lock.token === token) await lockIO.remove(installation.lockPath);
      } catch (error) { output(`Could not release update lock: ${updateDiagnostic(error)}`); }
    }
  }
}
