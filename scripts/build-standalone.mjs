#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const nodeVersion = '22.23.2';
const platform = process.platform;
const arch = process.arch;
if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`Unsupported standalone build host: ${platform}-${arch}`);
}
const output = resolve(process.argv[2] ?? join(root, '.build/standalone'));
const manifest = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8'));
const version = manifest.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Expected stable package version');
const stage = mkdtempSync(join(tmpdir(), 'laohuang-build-standalone-'));
function run(command, args, cwd = stage) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
async function download(url, path) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
  const contents = Buffer.from(await response.arrayBuffer());
  writeFileSync(path, contents);
  return contents;
}
try {
  mkdirSync(output, { recursive: true });
  const packageDir = join(stage, 'package');
  const app = join(packageDir, 'app');
  const runtime = join(packageDir, platform === 'win32' ? 'runtime' : 'runtime/bin');
  mkdirSync(app, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const npm = process.env.npm_execpath;
  if (!npm || !npm.endsWith('npm-cli.js')) throw new Error('Run this script through npm run build:standalone');
  const pack = run(process.execPath, [npm, 'pack', '--workspace', 'laohuang', '--ignore-scripts', '--json', '--pack-destination', stage], root);
  const tarball = join(stage, JSON.parse(pack.slice(pack.indexOf('[')))[0].filename);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ private: true, name: 'laohuang-standalone' }));
  run(process.execPath, [npm, 'install', '--prefix', app, '--ignore-scripts', '--omit=dev', '--include=optional', '--no-audit', '--no-fund', tarball]);

  const nodeArchive = `node-v${nodeVersion}-${platform === 'win32' ? 'win' : platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`;
  const sums = (await download(`${nodeBase}/SHASUMS256.txt`, join(stage, 'SHASUMS256.txt'))).toString('utf8');
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === nodeArchive)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official Node checksum is missing');
  const bytes = await download(`${nodeBase}/${nodeArchive}`, join(stage, nodeArchive));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Node download checksum mismatch');
  const nodeDirectoryName = nodeArchive.replace(/\.(zip|tar\.gz)$/, '');
  run('tar', ['-xf', nodeArchive, `${nodeDirectoryName}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`, `${nodeDirectoryName}/LICENSE`]);
  const nodeDir = join(stage, nodeDirectoryName);
  const node = join(runtime, platform === 'win32' ? 'node.exe' : 'node');
  copyFileSync(join(nodeDir, platform === 'win32' ? 'node.exe' : 'bin/node'), node);
  chmodSync(node, 0o755);
  copyFileSync(join(nodeDir, 'LICENSE'), join(packageDir, 'NODE-LICENSE'));
  copyFileSync(join(root, 'LICENSE'), join(packageDir, 'LICENSE'));
  for (const file of ['install.sh', 'install.ps1']) copyFileSync(join(root, file), join(packageDir, file));
  const launcher = platform === 'win32' ? 'laohuang.cmd' : 'laohuang';
  copyFileSync(join(root, 'apps/cli/standalone', launcher), join(packageDir, launcher));
  chmodSync(join(packageDir, launcher), 0o755);
  const actual = run(node, [join(app, 'node_modules/laohuang/dist/bin.js'), '--version']);
  if (actual !== `laohuang ${version}`) throw new Error(`Unexpected packaged version: ${actual}`);
  // Loading the native dependency catches missing platform-specific optional packages.
  run(node, ['--input-type=module', '-e', "import koffi from 'koffi'; import { Client } from '@modelcontextprotocol/client'; if (!koffi || !Client) process.exit(1);"], join(app, 'node_modules/laohuang'));
  const filename = `laohuang-${version}-${platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const archive = join(output, filename);
  if (platform === 'win32') run('tar', ['-a', '-cf', archive, '-C', packageDir, '.']);
  else run('tar', ['-czf', archive, '-C', packageDir, '.']);
  writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${filename}\n`);
  writeFileSync(join(output, 'version.txt'), `${version}\n`);
  console.log(`Standalone package verified: ${archive}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
