#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '.build/standalone'));
const version = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')).version;
const windows = process.platform === 'win32';
const archive = `laohuang-${version}-${process.platform}-${process.arch}.${windows ? 'zip' : 'tar.gz'}`;
const temp = mkdtempSync(join(tmpdir(), 'laohuang-standalone-smoke-'));
function run(command, args, env, input, timeout = 120_000) {
  return spawnSync(command, args, { cwd: temp, env, input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
}
function success(result) {
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
let primaryFailure = false;
try {
  const home = join(temp, 'new user');
  const install = join(home, 'installation');
  const source = join(temp, 'releases');
  const release = join(source, 'download', `v${version}`);
  mkdirSync(release, { recursive: true });
  mkdirSync(join(source, 'latest/download'), { recursive: true });
  mkdirSync(home);
  copyFileSync(join(output, archive), join(release, archive));
  copyFileSync(join(output, `${archive}.sha256`), join(release, `${archive}.sha256`));
  writeFileSync(join(source, 'latest/download/version.txt'), `${version}\n`);
  const env = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
    LAOHUANG_INSTALL_DIR: install, LAOHUANG_DOWNLOAD_BASE: pathToFileURL(source).href,
    LAOHUANG_CONFIG: join(home, 'config/config.json'),
  };
  let launch;
  if (windows) {
    // Retain Windows and Git tools, excluding any directory containing Node.
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'OS', 'ProgramFiles', 'ProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.Path = (process.env.Path ?? process.env.PATH ?? '').split(';').filter(path => path && !existsSync(join(path, 'node.exe'))).join(';');
    env.LOCALAPPDATA = join(home, 'AppData/Local');
    env.LAOHUANG_NO_MODIFY_PATH = '1';
    success(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'install.ps1')], env, undefined, 300_000));
    if (process.env.GITHUB_ACTIONS === 'true') {
      // Only the disposable runner account is used for persistent PATH checks.
      // Restore it even when the assertion or installer fails.
      const checkPath = join(temp, 'check-user-path.ps1');
      writeFileSync(checkPath, `
$ErrorActionPreference = 'Stop'
$before = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
  Remove-Item Env:LAOHUANG_NO_MODIFY_PATH
  & $env:LAOHUANG_INSTALLER_SCRIPT
  $first = [Environment]::GetEnvironmentVariable('Path', 'User')
  $bin = Join-Path $env:LAOHUANG_INSTALL_DIR 'bin'
  if (($first -split ';')[0] -ine $bin) { throw 'Installer did not persist its bin directory first in User PATH' }
  & $env:LAOHUANG_INSTALLER_SCRIPT
  if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $first) { throw 'Reinstallation duplicated PATH entries' }
  & laohuang --version
  if ($LASTEXITCODE -ne 0) { throw 'Command name failed after PATH configuration' }
} finally { [Environment]::SetEnvironmentVariable('Path', $before, 'User') }
`);
      success(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checkPath], { ...env, LAOHUANG_INSTALLER_SCRIPT: join(root, 'install.ps1') }, undefined, 600_000));
    }
    env.Path = join(install, 'bin') + ';' + env.Path;
    launch = (args, input) => run('powershell.exe', ['-NoProfile', '-Command', `& laohuang ${args.join(' ')}; exit $LASTEXITCODE`], env, input, args[0] === 'update' ? 300_000 : 120_000);
  } else {
    // Only installer utilities are available; even /usr/bin/node is excluded.
    const tools = join(temp, 'tools');
    mkdirSync(tools);
    for (const name of ['bash', 'sh', 'curl', 'tar', 'gzip', 'mktemp', 'uname', 'mkdir', 'tr', 'grep', 'cat', 'awk', 'sha256sum', 'shasum', 'sed', 'chmod', 'cp', 'mv', 'rm', 'rmdir', 'basename', 'dirname', 'ldd']) {
      const sourcePath = (process.env.PATH ?? '').split(delimiter).map(path => join(path, name)).find(path => existsSync(path));
      if (sourcePath) symlinkSync(sourcePath, join(tools, name));
    }
    env.PATH = tools;
    env.SHELL = '/bin/sh';
    assert.notEqual(run('/bin/sh', ['-c', 'command -v node'], env).status, 0);
    success(run('/bin/sh', [join(root, 'install.sh')], env));
    launch = (args, input) => run('/bin/sh', ['-c', '. "$HOME/.profile"; exec laohuang "$@"', 'standalone-smoke', ...args], env, input);
  }
  console.log('Checking installed command and first-run setup...');
  assert.equal(success(launch(['--version'])).trim(), `laohuang ${version}`);
  assert.match(success(launch(['--help'])), /usage: laohuang/);
  // A clean HOME reaches onboarding; blank selection cancels before any API key or model request.
  const onboarding = launch([], '\n');
  assert.equal(onboarding.status, 2, `${onboarding.stdout}\n${onboarding.stderr}`);
  assert.match(onboarding.stdout, /Select model provider/);
  const bin = join(install, 'bin', windows ? 'laohuang.cmd' : 'laohuang');
  const before = readFileSync(bin, 'utf8');
  console.log('Checking standalone update...');
  assert.match(success(launch(['update'])), /Installed laohuang/);
  assert.equal(readFileSync(`${bin}.bak`, 'utf8'), before);
  assert.equal(success(launch(['--version'])).trim(), `laohuang ${version}`);
  const updated = readFileSync(bin, 'utf8');
  writeFileSync(join(release, archive), 'damaged download');
  const rejected = launch(['update']);
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stderr}\n${rejected.stdout}`, /checksum mismatch/i);
  assert.equal(readFileSync(bin, 'utf8'), updated);
  assert.equal(success(launch(['--version'])).trim(), `laohuang ${version}`);
  assert.ok(readdirSync(join(install, 'releases')).every(name => !name.startsWith('.install')));
  console.log(`Standalone install, onboarding, update and failed-update recovery passed: ${process.platform}-${process.arch}`);
} catch (error) {
  primaryFailure = true;
  throw error;
} finally {
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (!primaryFailure) throw error;
    console.error('Temporary directory cleanup also failed:', error);
  }
}
