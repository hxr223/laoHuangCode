import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface LocalPathOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  shellPath?: () => string;
  convertShellPath?: (path: string) => string;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function convertVirtualPath(input: string, options: LocalPathOptions): string {
  if (options.convertShellPath) return options.convertShellPath(input);
  const candidates: string[] = [];
  const env = options.env ?? process.env;
  if (options.shellPath) {
    const directory = win32.dirname(options.shellPath());
    candidates.push(win32.join(directory, "cygpath.exe"), win32.resolve(directory, "../usr/bin/cygpath.exe"));
  } else {
    for (const name of ["ProgramFiles", "ProgramFiles(x86)"]) {
      const root = envValue(env, name);
      if (root && win32.isAbsolute(root)) candidates.push(win32.join(root, "Git", "usr", "bin", "cygpath.exe"));
    }
    for (const entry of (envValue(env, "PATH") ?? "").split(";")) {
      const directory = entry.replace(/^"(.*)"$/, "$1");
      if (win32.isAbsolute(directory)) {
        candidates.push(win32.join(directory, "cygpath.exe"), win32.resolve(directory, "../usr/bin/cygpath.exe"));
      }
    }
  }
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error(`Cannot map Git Bash path '${input}': cygpath.exe was not found. Use a Windows absolute path.`);
  // A path is one argv item, never executable shell text. Remove only cygpath's line ending.
  return execFileSync(executable, ["-w", "--", input], {
    encoding: "utf8", windowsHide: true, timeout: 5000,
  }).replace(/\r?\n$/, "");
}

export function getHomeDirectory(options: LocalPathOptions = {}): string {
  const windows = (options.platform ?? process.platform) === "win32";
  const env = options.env ?? process.env;
  const home = windows ? envValue(env, "USERPROFILE") || envValue(env, "HOME") || homedir() : env.HOME || homedir();
  return normalizeLocalPath(home, options, false);
}

export function normalizeLocalPath(input: string, options: LocalPathOptions = {}, expandHome = true): string {
  if (input.includes("\0")) throw new Error("Paths cannot contain a NUL character");
  const windows = (options.platform ?? process.platform) === "win32";
  const paths = windows ? win32 : posix;
  if (expandHome && (input === "~" || input.startsWith("~/") || (windows && input.startsWith("~\\")))) {
    return paths.join(getHomeDirectory(options), input.slice(2));
  }
  if (!windows) return input;
  // Preserve UNC and extended-length paths. Only shell-style rooted paths need mapping.
  if (input.startsWith("/") && !input.startsWith("//") && !input.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(input);
    if (drive) return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
    const converted = convertVirtualPath(input, options);
    if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(converted)) {
      throw new Error(`Git Bash path did not resolve to a Windows absolute path: ${input}`);
    }
    return converted;
  }
  return input;
}

export function resolveLocalPath(input: string, base = process.cwd(), options: LocalPathOptions = {}): string {
  const paths = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return paths.resolve(normalizeLocalPath(base, options), normalizeLocalPath(input, options));
}

export function displayLocalPath(input: string, home: string | null, platform = process.platform): string {
  if (!input || !home) return input;
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(input) || !paths.isAbsolute(home)) return input;
  const relative = paths.relative(home, input);
  if (relative === "") return "~";
  return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
    ? `~/${relative.split(paths.sep).join("/")}` : input;
}
