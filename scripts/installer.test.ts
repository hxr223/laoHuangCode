import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const windows = process.platform === "win32";
const posixTest = windows ? test.skip : test;
const windowsTest = windows ? test : test.skip;

function command(executable: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(executable, args, { encoding: "utf8", env, timeout: 30_000 });
}

function fixture(t: TestContext, options: { homeSuffix?: string; shell?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "laohuang-installer-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, options.homeSuffix ?? "home with spaces");
  mkdirSync(home);
  const install = join(home, "installation");
  const source = join(temp, "releases");
  const version = "9.8.7";
  const release = join(source, "download", `v${version}`);
  mkdirSync(release, { recursive: true });
  mkdirSync(join(source, "latest/download"), { recursive: true });
  writeFileSync(join(source, "latest/download/version.txt"), `${version}\n`);
  const payload = join(temp, "payload");
  mkdirSync(payload);
  const launcher = join(payload, "laohuang");
  writeFileSync(launcher, `#!/bin/sh\nprintf 'laohuang ${version}\\n'\n`);
  chmodSync(launcher, 0o755);
  const archiveName = `laohuang-${version}-${process.platform}-${process.arch}.tar.gz`;
  const archive = join(release, archiveName);
  const repack = () => {
    const packed = command("tar", ["-czf", archive, "-C", payload, "."]);
    assert.equal(packed.status, 0, packed.stderr);
    writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${archiveName}\n`);
  };
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: options.shell ?? "/bin/zsh",
    LAOHUANG_INSTALL_DIR: install, LAOHUANG_DOWNLOAD_BASE: pathToFileURL(source).href,
  };
  const run = (extra: NodeJS.ProcessEnv = {}, args: string[] = []) => command("/bin/sh", [join(root, "install.sh"), ...args], { ...env, ...extra });
  return { temp, home, install, source, payload, version, archive, launcher, env, repack, run };
}

posixTest("new-machine install configures zsh and works in a new shell without Node on PATH", (t) => {
  const f = fixture(t);
  f.repack();
  writeFileSync(join(f.home, ".zshrc"), "# existing user configuration\n");
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Open a new terminal/);
  const profile = readFileSync(join(f.home, ".zshrc"), "utf8");
  assert.ok(profile.startsWith("# existing user configuration\n"));
  const result = command("/bin/sh", ["-c", '. "$HOME/.zshrc"; laohuang --version'], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `laohuang ${f.version}`);
  assert.equal(existsSync(join(f.install, ".install-lock")), false);
  assert.ok(readdirSync(join(f.install, "releases")).every(name => !name.startsWith(".install")));
});

posixTest("reinstall is idempotent, retains the old launcher and preserves credentials", (t) => {
  const f = fixture(t);
  f.repack();
  const credentials = join(f.home, "credentials.json");
  writeFileSync(credentials, "fixture-credential-do-not-change");
  assert.equal(f.run().status, 0);
  const profile = readFileSync(join(f.home, ".zshrc"), "utf8");
  const before = readFileSync(join(f.install, "bin/laohuang"), "utf8");
  assert.equal(f.run().status, 0);
  assert.equal(readFileSync(join(f.home, ".zshrc"), "utf8"), profile);
  assert.equal(readFileSync(join(f.install, "bin/laohuang.bak"), "utf8"), before);
  assert.equal(command(join(f.install, "bin/laohuang.bak"), ["--version"], f.env).stdout.trim(), `laohuang ${f.version}`);
  assert.equal(readFileSync(credentials, "utf8"), "fixture-credential-do-not-change");
});

posixTest("checksum failure preserves the old entry and shell configuration", (t) => {
  const f = fixture(t);
  f.repack();
  assert.equal(f.run().status, 0);
  const before = readFileSync(join(f.install, "bin/laohuang"), "utf8");
  const profile = readFileSync(join(f.home, ".zshrc"), "utf8");
  writeFileSync(f.archive, "corrupted archive");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(readFileSync(join(f.install, "bin/laohuang"), "utf8"), before);
  assert.equal(readFileSync(join(f.home, ".zshrc"), "utf8"), profile);
  assert.equal(command(join(f.install, "bin/laohuang"), []).status, 0);
});

posixTest("a broken or mismatched downloaded program cannot replace a working version", (t) => {
  const f = fixture(t);
  f.repack();
  assert.equal(f.run().status, 0);
  const before = readFileSync(join(f.install, "bin/laohuang"), "utf8");
  for (const body of ["#!/bin/sh\nexit 1\n", "#!/bin/sh\necho 'laohuang 1.0.0'\n"]) {
    writeFileSync(f.launcher, body);
    f.repack();
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(join(f.install, "bin/laohuang"), "utf8"), before);
  }
});

posixTest("path opt-out leaves profiles alone and prints the exact manual command", (t) => {
  const f = fixture(t);
  f.repack();
  const result = f.run({}, ["--no-modify-path"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.home, ".zshrc")), false);
  assert.match(result.stdout, /PATH modification skipped/);
  assert.ok(result.stdout.includes(f.install));
});

posixTest("shell quoting preserves apostrophes and shell expressions without executing them", (t) => {
  const f = fixture(t, { homeSuffix: "user's $(touch injected) `touch backtick` $HOME" });
  f.repack();
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  const launched = command("/bin/sh", ["-c", '. "$HOME/.zshrc"; laohuang --version'], f.env);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout.trim(), `laohuang ${f.version}`);
});

posixTest("zsh respects ZDOTDIR and bash uses the correct platform startup file", (t) => {
  const f = fixture(t);
  f.repack();
  const zdot = join(f.home, "zsh config");
  assert.equal(f.run({ ZDOTDIR: zdot }).status, 0);
  assert.equal(existsSync(join(zdot, ".zshrc")), true);
  assert.equal(existsSync(join(f.home, ".zshrc")), false);
  assert.equal(f.run({ SHELL: "/bin/bash" }).status, 0);
  const profile = process.platform === "darwin" ? ".bash_profile" : ".bashrc";
  const launched = command("/bin/bash", ["--noprofile", "--norc", "-c", `. "$HOME/${profile}"; laohuang --version`], f.env);
  assert.equal(launched.status, 0, launched.stderr);
});

posixTest("fish uses its own PATH syntax and XDG config directory", (t) => {
  const f = fixture(t, { shell: "/usr/bin/fish" });
  f.repack();
  const config = join(f.home, "config");
  assert.equal(f.run({ XDG_CONFIG_HOME: config }).status, 0);
  assert.match(readFileSync(join(config, "fish/conf.d/laohuang.fish"), "utf8"), /fish_add_path -- /);
});

posixTest("bash keeps the existing login profile active and also configures non-login terminals", (t) => {
  const f = fixture(t, { shell: "/bin/bash" });
  f.repack();
  const marker = "export LAOHUANG_TEST_ORIGINAL_PROFILE=preserved\n";
  writeFileSync(join(f.home, ".profile"), marker);
  const installed = f.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(join(f.home, ".bash_profile")), false);
  assert.ok(readFileSync(join(f.home, ".profile"), "utf8").startsWith(marker));
  const login = command("/bin/bash", ["--login", "-c", 'test "$LAOHUANG_TEST_ORIGINAL_PROFILE" = preserved && laohuang --version'], f.env);
  assert.equal(login.status, 0, login.stderr);
  const interactive = command("/bin/bash", ["--noprofile", "-ic", "laohuang --version"], f.env);
  assert.equal(interactive.status, 0, interactive.stderr);
});

posixTest("an existing installation lock is retained without touching its owner", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.install, ".install-lock"), { recursive: true });
  writeFileSync(join(f.install, ".install-lock/owner"), "other process");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installation lock exists/);
  assert.equal(readFileSync(join(f.install, ".install-lock/owner"), "utf8"), "other process");
});

posixTest("invalid versions and path delimiters fail before installing a command", (t) => {
  const f = fixture(t);
  for (const version of ["../escape", "1.2.3\n1.2.3", "v1.2.3", "1.2"]) {
    assert.notEqual(f.run({}, ["--version", version]).status, 0);
  }
  assert.notEqual(f.run({ LAOHUANG_INSTALL_DIR: `${f.install}:other` }).status, 0);
  assert.equal(existsSync(join(f.install, "bin/laohuang")), false);
});

// Real package smoke exercises Windows download/extraction/launching. These
// checks cover fail-fast paths without depending on a published release.
windowsTest("Windows installer rejects unsupported paths and versions without changing PATH", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "laohuang-windows-installer-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const [install, version] of [[join(temp, "bad;path"), "1.2.3"], [join(temp, "valid"), "../escape"]]) {
    const result = command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "install.ps1"), "-InstallDir", install!, "-Version", version!, "-NoModifyPath"]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(install!, "bin/laohuang.cmd")), false);
  }
});
