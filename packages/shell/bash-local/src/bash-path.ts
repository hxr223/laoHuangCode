import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ResolveBashPathOptions {
  shellPath?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  isExecutable?: (pathname: string) => boolean;
}

/** Locate Bash without invoking a shell or falling back to a different language. */
export function resolveBashPath(options: ResolveBashPathOptions = {}): string {
  const windows = (options.platform ?? process.platform) === "win32";
  const paths = windows ? win32 : posix;
  const env = options.env ?? process.env;
  const isExecutable = options.isExecutable ?? ((pathname: string): boolean => {
    try {
      if (!statSync(pathname).isFile()) return false;
      accessSync(pathname, windows ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const environment = (name: string): string | undefined => {
    const key = windows
      ? Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase())
      : name;
    return key === undefined ? undefined : env[key];
  };
  const isLegacyWsl = (pathname: string): boolean => windows &&
    /[\\/]windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(pathname);

  if (options.shellPath !== undefined) {
    let explicit = options.shellPath;
    if (explicit === "~" || explicit.startsWith("~/") || (windows && explicit.startsWith("~\\"))) {
      explicit = paths.join(options.homeDirectory ?? homedir(), explicit.slice(2));
    }
    if (!paths.isAbsolute(explicit)) {
      throw new Error("shell_path must be an absolute Bash path (or start with ~/).");
    }
    if (isLegacyWsl(explicit)) {
      throw new Error("shell_path points to a legacy WSL launcher; select Git for Windows bash.exe instead.");
    }
    if (!isExecutable(explicit)) {
      throw new Error(`Configured Bash is missing or not executable: ${explicit}`);
    }
    return explicit;
  }

  const candidates: string[] = [];
  if (windows) {
    for (const name of ["ProgramFiles", "ProgramFiles(x86)"]) {
      const directory = environment(name);
      if (directory && paths.isAbsolute(directory)) {
        candidates.push(paths.join(directory, "Git", "bin", "bash.exe"));
      }
    }
  } else {
    candidates.push("/bin/bash");
  }
  for (const entry of (environment("PATH") ?? "").split(paths.delimiter)) {
    const directory = windows && entry.startsWith('"') && entry.endsWith('"')
      ? entry.slice(1, -1)
      : entry;
    // Do not implicitly select executables from the current project directory.
    if (paths.isAbsolute(directory)) {
      candidates.push(paths.join(directory, windows ? "bash.exe" : "bash"));
    }
  }
  for (const candidate of new Set(candidates)) {
    if (!isLegacyWsl(candidate) && isExecutable(candidate)) return candidate;
  }
  throw new Error(windows
    ? "Bash not found. Install Git for Windows, add its bin directory to PATH, or set shell_path in config.json."
    : "Bash not found. Install Bash, add its directory to PATH, or set shell_path in config.json.");
}
