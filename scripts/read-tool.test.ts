import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTestToolRegistry } from "./test-tool-registry.ts";

test("read limits a page to 2000 lines and resumes without skipping content", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = "line\n".repeat(2001);
  await fs.writeFile(path.join(root, "lines.txt"), original);
  const tools = createTestToolRegistry(root);

  const first = await tools.execute("read", { path: "lines.txt" });
  assert.equal(first.content, "line\n".repeat(2000));
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 2001);
  const last = await tools.execute("read", { path: "lines.txt", offset: first.next_offset });
  assert.equal(last.has_more, false);
  assert.equal(last.next_offset, null);
  assert.equal(String(first.content) + last.content, original);
});

test("read enforces 50 KiB in UTF-8 bytes and resumes at the first omitted line", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const line = "中".repeat(1000) + "\n";
  const original = line.repeat(20);
  await fs.writeFile(path.join(root, "unicode.txt"), original);
  const tools = createTestToolRegistry(root);

  const first = await tools.execute("read", { path: "unicode.txt" });
  assert.equal(Buffer.byteLength(first.content!), 17 * 3001);
  assert.equal(first.has_more, true);
  assert.equal(first.next_offset, 18);
  const last = await tools.execute("read", { path: "unicode.txt", offset: first.next_offset });
  assert.equal(last.has_more, false);
  assert.equal(String(first.content) + last.content, original);
});

test("read caps long lines at 2000 Unicode characters and reports omitted content at EOF", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "long.txt"), "before\r\n" + "😀".repeat(2001));
  const tools = createTestToolRegistry(root);

  const result = await tools.execute("read", { path: "long.txt", offset: 2 });
  assert.equal(Array.from(result.content!).length, 2000);
  assert.equal(result.content!.isWellFormed(), true);
  assert.equal(result.has_more, true);
  assert.equal(result.next_offset, null);
  assert.deepEqual(result.truncated_line_numbers, [2]);
  assert.match(String(result.note), /Bash/);
});

test("read returns exactly 50 KiB without a false truncation and preserves CRLF", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = ("a".repeat(1022) + "\r\n").repeat(50);
  await fs.writeFile(path.join(root, "exact.txt"), original);
  const result = await createTestToolRegistry(root).execute("read", { path: "exact.txt" });
  assert.equal(Buffer.byteLength(result.content!), 50 * 1024);
  assert.equal(result.content, original);
  assert.equal(result.has_more, false);
  assert.equal(result.next_offset, null);
  assert.deepEqual(result.truncated_line_numbers, []);
});

test("read accepts exactly 2000 characters per line and rejects limits above 2000", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = "a".repeat(2000) + "\r\n" + "中".repeat(2000);
  await fs.writeFile(path.join(root, "exact.txt"), original);
  const tools = createTestToolRegistry(root);
  const result = await tools.execute("read", { path: "exact.txt" });
  assert.equal(result.content, original);
  assert.equal(result.has_more, false);
  assert.deepEqual(result.truncated_line_numbers, []);
  const invalid = await tools.execute("read", { path: "exact.txt", limit: 2001 });
  assert.equal(invalid.ok, false);
  assert.match(String(invalid.error), /limit.*2000/);
});

test("read advances past a huge first line and only marks shortened lines actually returned", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "huge.txt"), ("😀".repeat(20000) + "\n").repeat(8));
  const tools = createTestToolRegistry(root);
  const first = await tools.execute("read", { path: "huge.txt" });
  assert.equal(first.content, ("😀".repeat(2000) + "\n").repeat(6));
  assert.ok(Buffer.byteLength(first.content!) <= 50 * 1024);
  assert.equal(first.next_offset, 7);
  assert.deepEqual(first.truncated_line_numbers, [1, 2, 3, 4, 5, 6]);
  const last = await tools.execute("read", { path: "huge.txt", offset: first.next_offset });
  assert.equal(last.next_offset, null);
  assert.equal(last.has_more, true);
  assert.deepEqual(last.truncated_line_numbers, [7, 8]);
});
