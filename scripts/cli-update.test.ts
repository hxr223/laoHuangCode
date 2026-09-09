import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { compareStableVersions, runUpdate, updateDiagnostic } from "../apps/cli/src/update.ts";
import { createNpmRunner, resolveNpmInstallation } from "../apps/cli/src/update-installation.ts";
import type { NpmInstallation, NpmRunner } from "../apps/cli/src/update-installation.ts";

async function temporary(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laohuang-update-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function packageFixture(root: string, version = "1.0.0"): Promise<string> {
  await writeJson(join(root, "package.json"), { name: "laohuang", version, bin: { laohuang: "dist/bin.js" } });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist/bin.js"), "// fixture");
  return join(root, "dist/bin.js");
}

async function localFixture(t: TestContext, options: { workspace?: boolean; range?: string; bucket?: string; ambiguous?: boolean } = {}) {
  const root = await temporary(t);
  const packageRoot = join(root, "node_modules/laohuang");
  const entry = await packageFixture(packageRoot);
  const range = options.range ?? "^1.0.0";
  const bucket = options.bucket ?? "dependencies";
  const owner = options.workspace ? "apps/consumer" : "";
  const dependency = { [bucket]: { laohuang: range } };
  const rootManifest = options.workspace ? { name: "root", workspaces: ["apps/*"], ...(options.ambiguous ? dependency : {}) } : { name: "root", ...dependency };
  await writeJson(join(root, "package.json"), rootManifest);
  if (owner) await writeJson(join(root, owner, "package.json"), { name: "consumer", ...dependency });
  const packages = {
    "": rootManifest,
    ...(owner ? { [owner]: { name: "consumer", ...dependency }, "node_modules/consumer": { link: true, resolved: owner } } : {}),
    "node_modules/laohuang": { version: "1.0.0", resolved: "https://registry.example/laohuang/-/laohuang-1.0.0.tgz" },
  };
  await writeJson(join(root, "package-lock.json"), { lockfileVersion: 3, packages });
  const calls: string[][] = [];
  const npm: NpmRunner = { async run(args) {
    calls.push([...args]);
    if (args[0] === "query") return { code: 0, stdout: JSON.stringify(owner ? [{ location: owner, realpath: join(root, owner) }] : []), stderr: "" };
    return { code: 1, stdout: "", stderr: "not global" };
  } };
  return { root, packageRoot, entry, calls, discovery: { cliPaths: ["/fake/npm-cli.js"], createRunner: () => npm } };
}

async function updateFixture(t: TestContext, behavior: { latest?: unknown; queryCode?: number; installCode?: number; actual?: string | null; error?: Error } = {}) {
  const root = await temporary(t);
  const packageRoot = join(root, "node_modules/laohuang");
  await packageFixture(packageRoot);
  const calls: string[][] = [];
  const messages: string[] = [];
  const npm: NpmRunner = { async run(args) {
    calls.push([...args]);
    if (behavior.error) throw behavior.error;
    if (args[0] === "view") return { code: behavior.queryCode ?? 0, stdout: JSON.stringify(behavior.latest ?? "1.1.0"), stderr: "query failed" };
    if (behavior.actual === null) await rm(packageRoot, { recursive: true });
    else await packageFixture(packageRoot, behavior.actual ?? String(behavior.latest ?? "1.1.0"));
    return { code: behavior.installCode ?? 0, stdout: "", stderr: "install failed" };
  } };
  const installation: NpmInstallation = { packageRoot, installedVersion: "1.0.0", workingDirectory: root, npm, installArgs: ["--save-prefix=^"], lockPath: join(root, ".laohuang-update.lock") };
  return { root, installation, calls, messages, output: (message: string) => messages.push(message) };
}

test("stable versions compare numerically", () => {
  assert.equal(compareStableVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareStableVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareStableVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareStableVersions("99999999999999999999.0.0", "99999999999999999998.0.0"), 1);
  for (const value of ["1.0.0-beta.1", "01.0.0", "1.0", "1.0.0\n", "1.0.0+build"]) {
    assert.throws(() => compareStableVersions(value, "1.0.0"));
  }
});

test("global discovery matches the real executable and pins the matching prefix", async t => {
  const root = await temporary(t);
  const prefix = join(root, "matching");
  const packageRoot = join(prefix, "lib/node_modules/laohuang");
  const entry = await packageFixture(packageRoot);
  const other = join(root, "other");
  await mkdir(join(other, "lib/node_modules"), { recursive: true });
  const calls: string[][] = [];
  const installation = await resolveNpmInstallation(entry, {}, {
    cliPaths: ["other", "matching"],
    createRunner: cli => ({ async run(args) {
      calls.push([cli, ...args]);
      const selected = cli === "matching" ? prefix : other;
      return { code: 0, stdout: args[0] === "prefix" ? selected : join(selected, "lib/node_modules"), stderr: "" };
    } }),
  });
  assert.equal(installation.packageRoot, packageRoot);
  assert.deepEqual(installation.installArgs, ["--global", "--prefix", prefix]);
  assert.equal(installation.lockPath, join(prefix, "lib/node_modules/.laohuang-update.lock"));
  assert.ok(calls.some(args => args.includes("--prefix")));
});

test("local dependency declarations preserve range, bucket and workspace owner", async t => {
  for (const workspace of [false, true]) {
    for (const [range, bucket, expected] of [["^1.0.0", "dependencies", "--save-prefix=^"], ["~1.0.0", "devDependencies", "--save-prefix=~"], ["1.0.0", "optionalDependencies", "--save-exact"]]) {
      await t.test(`${workspace ? "workspace" : "root"} ${range}`, async t => {
        const fixture = await localFixture(t, { workspace, range, bucket });
        const installation = await resolveNpmInstallation(fixture.entry, {}, fixture.discovery);
        assert.equal(installation.packageRoot, fixture.packageRoot);
        assert.equal(installation.workingDirectory, fixture.root);
        assert.ok(installation.installArgs.includes(expected!));
        assert.ok(installation.installArgs.includes(bucket === "dependencies" ? "--save-prod" : bucket === "devDependencies" ? "--save-dev" : "--save-optional"));
        assert.equal(installation.installArgs.includes("--workspace"), workspace);
      });
    }
  }
});

test("ambiguous owners and unsupported sources are refused", async t => {
  for (const range of [">=1.0.0", "npm:other@1.0.0", "file:../local", "git+https://example/repo", "latest"]) {
    const fixture = await localFixture(t, { range });
    await assert.rejects(resolveNpmInstallation(fixture.entry, {}, fixture.discovery), /not a supported/);
  }
  const ambiguous = await localFixture(t, { workspace: true, ambiguous: true });
  await assert.rejects(resolveNpmInstallation(ambiguous.entry, {}, ambiguous.discovery), /Ambiguous/);
  const source = await temporary(t);
  const entry = await packageFixture(join(source, "source"));
  await assert.rejects(resolveNpmInstallation(entry, {}), /direct npm/);
  await mkdir(join(source, "node_modules"));
  await symlink(join(source, "source"), join(source, "node_modules/laohuang"), "dir");
  await assert.rejects(resolveNpmInstallation(join(source, "node_modules/laohuang/dist/bin.js"), {}), /direct npm/);
  for (const folder of ["_npx/cache/node_modules/laohuang", ".pnpm/cache/node_modules/laohuang"]) {
    await assert.rejects(resolveNpmInstallation(await packageFixture(join(source, folder)), {}), /direct npm/);
  }
});

test("lock, package manager and actual resolution must all identify current installation", async t => {
  const fixture = await localFixture(t, { workspace: true });
  await packageFixture(join(fixture.root, "apps/consumer/node_modules/laohuang"));
  await assert.rejects(resolveNpmInstallation(fixture.entry, {}, fixture.discovery), /No direct/);
  const alternate = await localFixture(t);
  await writeFile(join(alternate.root, "yarn.lock"), "");
  await assert.rejects(resolveNpmInstallation(alternate.entry, {}, alternate.discovery), /package manager/);
  const transitive = await localFixture(t);
  await writeJson(join(transitive.root, "package.json"), { name: "root" });
  await assert.rejects(resolveNpmInstallation(transitive.entry, {}, transitive.discovery), /No direct/);
  const stale = await localFixture(t);
  await packageFixture(stale.packageRoot, "9.0.0");
  await assert.rejects(resolveNpmInstallation(stale.entry, {}, stale.discovery), /lockfile/);
});

test("successful update installs exact latest once, verifies disk, releases lock", async t => {
  const fixture = await updateFixture(t);
  assert.equal(await runUpdate(fixture), 0);
  assert.deepEqual(fixture.calls, [["view", "laohuang@latest", "version", "--json"], ["install", "laohuang@1.1.0", "--save-prefix=^", "--include=prod", "--include=optional", "--dry-run=false", "--package-lock-only=false", "--ignore-scripts"]]);
  assert.match(fixture.messages.join(""), /Updated laohuang 1.0.0 → 1.1.0/);
  await assert.rejects(readFile(fixture.installation.lockPath), { code: "ENOENT" });
});

test("latest and newer installations do not install, including version changed since discovery", async t => {
  for (const current of ["1.1.0", "2.0.0"]) {
    const fixture = await updateFixture(t);
    await packageFixture(fixture.installation.packageRoot, current);
    assert.equal(await runUpdate(fixture), 0);
    assert.equal(fixture.calls.length, 1);
  }
});

test("invalid queries and failed operations return failure without false rollback claims", async t => {
  for (const behavior of [{ latest: ["1.1.0"] }, { latest: "1.1.0-beta.1" }, { queryCode: 1 }, { installCode: 1 }, { actual: "1.0.0" }, { actual: null }, { error: new Error("spawn failed") }]) {
    const fixture = await updateFixture(t, behavior);
    assert.equal(await runUpdate(fixture), 1);
    assert.doesNotMatch(fixture.messages.join(""), /rolled back/i);
    if (fixture.calls.length === 2) assert.match(fixture.messages.join(""), /may have changed/);
    await assert.rejects(readFile(fixture.installation.lockPath), { code: "ENOENT" });
  }
});

test("occupied and replaced locks are never removed", async t => {
  const fixture = await updateFixture(t);
  await writeJson(fixture.installation.lockPath, { pid: 123, token: "existing" });
  assert.equal(await runUpdate(fixture), 1);
  assert.equal(fixture.calls.length, 0);
  assert.match(await readFile(fixture.installation.lockPath, "utf8"), /existing/);
  assert.match(fixture.messages.join(""), /confirming no update process/);
  await rm(fixture.installation.lockPath);
  const npm: NpmRunner = { async run() {
    await writeJson(fixture.installation.lockPath, { token: "replacement" });
    return { code: 0, stdout: '"1.0.0"', stderr: "" };
  } };
  assert.equal(await runUpdate({ ...fixture, installation: { ...fixture.installation, npm } }), 0);
  assert.match(await readFile(fixture.installation.lockPath, "utf8"), /replacement/);
});

test("lock creation failures and pre-cancelled updates never spawn npm", async t => {
  const fixture = await updateFixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await runUpdate({ ...fixture, signal: controller.signal }), 130);
  assert.equal(await runUpdate({ ...fixture, installation: { ...fixture.installation, lockPath: join(fixture.root, "missing/lock") } }), 1);
  assert.equal(fixture.calls.length, 0);
});

test("diagnostics redact credentials, strip terminal controls and remain bounded", () => {
  const result = updateDiagnostic("\x1b[31m\nhttps://user:secret@registry.example/?token=hidden _authToken=abc npm_sensitive Bearer opaque \"password\":\"quotedsecret\" " + "a".repeat(1000));
  assert.ok(result.length <= 600);
  assert.doesNotMatch(result, /secret|hidden|abc|sensitive|opaque|\x1b|\n/);
});

test("lock failures stop before npm and preserve locks without established ownership", async t => {
  for (const stage of ["acquire", "write", "close"]) {
    const fixture = await updateFixture(t);
    let contents = "";
    let removed = 0;
    assert.equal(await runUpdate({ ...fixture, lockIO: {
      async acquire() {
        if (stage === "acquire") throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return {
          async writeFile(value) { if (stage === "write") throw new Error("write failed"); contents = value; },
          async close() { if (stage === "close") throw new Error("close failed"); },
        };
      },
      async read() { return contents; },
      async remove() { removed++; },
    } }), 1);
    assert.equal(removed, stage === "close" ? 1 : 0);
    assert.equal(fixture.calls.length, 0);
  }
});

test("replacement lock survives a failed initialization write", async t => {
  const fixture = await updateFixture(t);
  assert.equal(await runUpdate({ ...fixture, lockIO: {
    async acquire(path) {
      await writeFile(path, "", { flag: "wx" });
      return {
        async writeFile() {
          await rm(path);
          await writeJson(path, { token: "replacement" });
          throw new Error("initialization write failed");
        },
        async close() {},
      };
    },
    read: path => readFile(path, "utf8"),
    remove: path => rm(path),
  } }), 1);
  assert.equal(fixture.calls.length, 0);
  assert.match(await readFile(fixture.installation.lockPath, "utf8"), /replacement/);
});

test("selected dependency remains physically installed despite omission and non-install modes", async t => {
  for (const bucket of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const fixture = await localFixture(t, { bucket });
    const environ = { NODE_ENV: "production", npm_config_omit: "dev optional prod", npm_config_dry_run: "true", npm_config_package_lock_only: "true" };
    const scoped = await resolveNpmInstallation(fixture.entry, environ, fixture.discovery);
    let physicallyInstalled = false;
    const npm: NpmRunner = { async run(args) {
      if (args[0] === "view") return { code: 0, stdout: '"1.1.0"', stderr: "" };
      // Model npm config priority and include-over-omit behavior, not only argv presence.
      const config = new Map<string, string>([["dry-run", environ.npm_config_dry_run], ["package-lock-only", environ.npm_config_package_lock_only]]);
      const includes = new Set<string>();
      for (const arg of args) {
        const match = /^--([^=]+)=(.*)$/.exec(arg);
        if (match) { if (match[1] === "include") includes.add(match[2]!); else config.set(match[1]!, match[2]!); }
      }
      const kind = bucket === "devDependencies" ? "dev" : bucket === "optionalDependencies" ? "optional" : "prod";
      if (config.get("dry-run") === "true" || config.get("package-lock-only") === "true") return { code: 0, stdout: "", stderr: "" };
      if (!includes.has(kind)) await rm(fixture.packageRoot, { recursive: true });
      else { await packageFixture(fixture.packageRoot, "1.1.0"); physicallyInstalled = true; }
      return { code: 0, stdout: "", stderr: "" };
    } };
    assert.equal(await runUpdate({ installation: { ...scoped, npm }, output() {} }), 0);
    assert.equal(physicallyInstalled, true);
    assert.equal(JSON.parse(await readFile(join(fixture.packageRoot, "package.json"), "utf8")).version, "1.1.0");
  }
});

test("Windows taskkill nonzero and timeout paths terminate the npm child before rejecting", async t => {
  for (const timedOut of [false, true]) {
    const root = await temporary(t);
    const script = join(root, "npm-cli.cjs");
    const marker = join(root, "late-write");
    await writeFile(script, `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 700); setInterval(()=>{},100);`);
    const killerScript = join(root, "taskkill.cjs");
    await writeFile(killerScript, timedOut ? "setInterval(()=>{},100);" : "process.exit(1);");
    let pid: number | undefined;
    t.after(() => { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } });
    const runner = createNpmRunner(script, process.env, {
      platform: "win32",
      spawnTaskkill(target) {
        pid = target;
        return spawn(process.execPath, [killerScript], { stdio: "ignore", timeout: 50, killSignal: "SIGKILL" });
      },
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(Promise.race([
        runner.run([], { cwd: root, timeoutMs: 100 }),
        new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("runner hung")), 1000); }),
      ]), /process tree cleanup failed/);
    } finally { if (watchdog) clearTimeout(watchdog); }
    assert.ok(pid);
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
    await new Promise(resolve => setTimeout(resolve, 750));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});

test("discovery cancellation is propagated to the active npm query", async t => {
  const fixture = await localFixture(t);
  const controller = new AbortController();
  let completed = false;
  await assert.rejects(resolveNpmInstallation(fixture.entry, {}, {
    cliPaths: ["fake"], signal: controller.signal,
    createRunner: () => ({ async run(_args, options) {
      assert.equal(options.signal, controller.signal);
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 10));
      completed = true;
      throw new Error("cancelled");
    } }),
  }));
  assert.equal(completed, true);
});

test("cancellation during installation reports possible changes and releases lock", async t => {
  const fixture = await updateFixture(t);
  const controller = new AbortController();
  const npm: NpmRunner = { async run(args) {
    if (args[0] === "view") return { code: 0, stdout: '"1.1.0"', stderr: "" };
    controller.abort();
    throw new Error("cancelled");
  } };
  assert.equal(await runUpdate({ ...fixture, installation: { ...fixture.installation, npm }, signal: controller.signal }), 130);
  assert.match(fixture.messages.join(""), /may have changed/);
  await assert.rejects(readFile(fixture.installation.lockPath), { code: "ENOENT" });
});

test("npm runner strips routing environment overrides but keeps registry authentication", async t => {
  const root = await temporary(t);
  const script = join(root, "npm-cli.cjs");
  await writeFile(script, "process.stdout.write(JSON.stringify({global:process.env.npm_config_global,workspace:process.env.npm_config_workspace,save:process.env.npm_config_save,registry:process.env.npm_config_registry,auth:process.env.npm_config__authToken}));");
  const result = await createNpmRunner(script, { ...process.env, npm_config_global: "true", npm_config_workspace: "wrong", npm_config_save: "false", npm_config_registry: "https://registry.example", npm_config__authToken: "fixture" }).run([], { cwd: root, timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(result.stdout), { registry: "https://registry.example", auth: "fixture" });
});

test("npm runner uses argv without shell and bounds captured output", async t => {
  const root = await temporary(t);
  const script = join(root, "npm-cli.cjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write('x'.repeat(100000));");
  const result = await createNpmRunner(script, process.env).run(["a b", "$(touch never)", "'quoted'"], { cwd: root, timeoutMs: 1000 });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["a b", "$(touch never)", "'quoted'"]);
  assert.equal(result.stderr.length, 65_536);
  await assert.rejects(createNpmRunner(script, process.env).run([], { cwd: join(root, "missing"), timeoutMs: 1000 }));
});

test("timeout and cancellation wait for npm and its process group to stop", { skip: process.platform === "win32" }, async t => {
  for (const cancelled of [false, true]) {
    const root = await temporary(t);
    const script = join(root, "npm-cli.cjs");
    const marker = join(root, "late-write");
    const descendant = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 1200); setInterval(()=>{},100);`;
    await writeFile(script, `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`);
    const controller = new AbortController();
    const cancelTimer = cancelled ? setTimeout(() => controller.abort(), 100) : undefined;
    await assert.rejects(createNpmRunner(script, process.env).run([], { cwd: root, timeoutMs: cancelled ? 5000 : 100, signal: controller.signal }), cancelled ? /cancelled/ : /timed out/);
    if (cancelTimer) clearTimeout(cancelTimer);
    await new Promise(resolve => setTimeout(resolve, 1250));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});
