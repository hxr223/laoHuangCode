import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { displayLocalPath, getHomeDirectory, normalizeLocalPath, resolveLocalPath } from "../packages/fs/local-paths/src/index.ts";
import { createFileToolDefinitions } from "../packages/fs/tool-fs/src/file-tools.ts";
import { createBashToolDefinition } from "../packages/shell/tool-bash/src/tool-bash.ts";
import { defaultConfigPath } from "../packages/storage/local-config/src/config.ts";

const windows = { platform: "win32" as const, env: { USERPROFILE: "C:\\Users\\alice" } };

test("Windows shell drive paths resolve natively without touching UNC or extended paths", () => {
  for (const prefix of ["/c", "/mnt/c", "/cygdrive/c"]) {
    assert.equal(normalizeLocalPath(`${prefix}/work/a b.txt`, windows), "C:\\work\\a b.txt");
    assert.equal(normalizeLocalPath(prefix, windows), "C:\\");
  }
  for (const input of ["C:\\work\\a.txt", "C:/work/a.txt", "\\\\server\\share\\file", "//server/share/file", "\\\\?\\C:\\long\\file"]) {
    assert.equal(normalizeLocalPath(input, windows), input);
  }
  assert.equal(resolveLocalPath("../file", "D:\\work\\sub", windows), "D:\\work\\file");
  assert.equal(resolveLocalPath("/c/work/file", "D:\\work", windows), "C:\\work\\file");
});

test("home expansion and display respect Windows separators and directory boundaries", () => {
  assert.equal(normalizeLocalPath("~\\folder", windows), "C:\\Users\\alice\\folder");
  assert.equal(normalizeLocalPath("~/folder", windows), "C:\\Users\\alice\\folder");
  assert.equal(getHomeDirectory({ platform: "win32", env: { UserProfile: "D:\\home", HOME: "C:\\other" } }), "D:\\home");
  assert.equal(displayLocalPath("c:\\users\\Alice\\work", "C:\\Users\\alice", "win32"), "~/work");
  assert.equal(displayLocalPath("C:\\Users\\alice2", "C:\\Users\\alice", "win32"), "C:\\Users\\alice2");
  assert.equal(displayLocalPath("D:\\work", "C:\\Users\\alice", "win32"), "D:\\work");
});

test("virtual Git Bash paths use the selected shell mapping and reject invalid conversions", () => {
  const seen: string[] = [];
  assert.equal(normalizeLocalPath("/usr/a b", { ...windows, convertShellPath: (value) => {
    seen.push(value);
    return "D:\\Git\\usr\\a b";
  } }), "D:\\Git\\usr\\a b");
  assert.deepEqual(seen, ["/usr/a b"]);
  assert.throws(() => normalizeLocalPath("/usr/bin", { ...windows, convertShellPath: () => "relative" }), /absolute path/);
  assert.throws(() => normalizeLocalPath("a\0b", windows), /NUL/);
});

test("POSIX paths retain their meaning", () => {
  const options = { platform: "linux" as const, env: { HOME: "/home/alice" } };
  assert.equal(normalizeLocalPath("/c/work", options), "/c/work");
  assert.equal(normalizeLocalPath("~/file", options), "/home/alice/file");
  assert.equal(normalizeLocalPath("~\\file", options), "~\\file");
});

test("virtual config paths find cygpath beside a custom Git bin on PATH", (t) => {
  const executable = "D:\\Tools\\Git\\usr\\bin\\cygpath.exe";
  const input = "/usr/local/a b;literal/config.json";
  const candidates: string[] = [];
  t.mock.method(fs, "existsSync", (candidate: string) => { candidates.push(candidate); return candidate === executable; });
  const convert = t.mock.method(childProcess, "execFileSync", (file: string, args: string[]) => {
    assert.equal(file, executable);
    assert.deepEqual(args, ["-w", "--", input]);
    return "D:\\Tools\\Git\\usr\\local\\a b;literal\\config.json\r\n";
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = normalizeLocalPath(input, { platform: "win32", env: { ProgramFiles: ".", Path: '.;"D:\\Tools\\Git\\bin"' } });
  assert.equal(result, "D:\\Tools\\Git\\usr\\local\\a b;literal\\config.json");
  assert.equal(convert.mock.callCount(), 1);
  assert.ok(candidates.every((candidate) => win32.isAbsolute(candidate)));
});

test("file tools and Bash workdir share home expansion without rewriting commands", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "laohuang-paths-")));
  const env = { HOME: home, USERPROFILE: home };
  const execution = { isCancelled: () => false };
  try {
    const tools = createFileToolDefinitions({ projectRoot: home, pathOptions: { env } });
    const write = tools.find((tool) => tool.spec.name === "write")!;
    const read = tools.find((tool) => tool.spec.name === "read")!;
    const edit = tools.find((tool) => tool.spec.name === "edit")!;
    await write.execute({ path: "~/a.txt", content: "before" }, execution);
    await edit.execute({ path: "~/a.txt", edits: [{ old_text: "before", new_text: "after" }] }, execution);
    const result = await read.execute({ path: join(home, "a.txt") }, execution);
    assert.equal(result.content, "after");
    const bash = createBashToolDefinition({ projectRoot: home, env, runBash: async (command, options) => {
      assert.equal(command, "printf '/c/not-a-path-argument'");
      assert.equal(options.cwd, await fs.promises.realpath(home));
      return { ok: true };
    } });
    await bash.execute({ command: "printf '/c/not-a-path-argument'", description: "test", workdir: "~" }, execution);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config expansion uses the supplied environment home", () => {
  const home = join(tmpdir(), "laohuang-config-home");
  assert.equal(defaultConfigPath({ HOME: home, USERPROFILE: home, LAOHUANG_CONFIG: "~/config.json" }), join(home, "config.json"));
});

test("native Windows Bash output paths round-trip into file tools", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "laohuang-path-roundtrip-")));
  const execution = { isCancelled: () => false };
  try {
    const bash = createBashToolDefinition({ projectRoot: root });
    const result = await bash.execute({ command: "printf contents > 'win file.txt'; pwd", description: "path roundtrip" }, execution);
    assert.equal(result.ok, true);
    const tools = createFileToolDefinitions({ projectRoot: root });
    const read = tools.find((tool) => tool.spec.name === "read")!;
    const output = await read.execute({ path: `${String(result.stdout).trim()}/win file.txt` }, execution);
    assert.equal(output.content, "contents");
    const mapped = normalizeLocalPath("/usr/bin");
    assert.match(mapped, /^[a-z]:[\\/]/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
