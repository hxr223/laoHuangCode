import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adaptMcpResult } from "../packages/core/mcp/src/output.ts";
import { mcpToolName } from "../packages/core/mcp/src/tool-adapter.ts";

test("normalized remote names do not alias", () => {
  assert.notEqual(mcpToolName("a-b", "read"), mcpToolName("a_b", "read"));
  assert.match(mcpToolName("长".repeat(100), "tool".repeat(100)), /^[a-zA-Z0-9_]{1,64}$/);
});

test("serialized byte limit preserves complete structured and media output in files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-output-"));
  try {
    const text = '\"\\\n中'.repeat(20000);
    const input = { content: [{ type: "text" as const, text }, { type: "image" as const, data: Buffer.from("image").toString("base64"), mimeType: "image/png" }], structuredContent: { rows: [1, 2, 3] }, _meta: { secret: "protocol-only" } };
    const result = await adaptMcpResult(input, { artifactRoot: root });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 51200);
    assert.equal(result.truncated, true);
    assert.equal(typeof result.path, "string");
    const stored = JSON.parse(await readFile(result.path!, "utf8"));
    assert.equal(stored.content[0].text, text);
    assert.deepEqual(stored.structuredContent, { rows: [1, 2, 3] });
    assert.equal(stored._meta, undefined);
    const attachments = result.attachments as { path: string }[];
    assert.equal(await readFile(attachments[0]!.path, "utf8"), "image");
    assert.equal(dirname(attachments[0]!.path), dirname(result.path!));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("business errors and output-storage failures are not reported as success", async () => {
  assert.equal((await adaptMcpResult({ content: [{ type: "text", text: "denied" }], isError: true }, { artifactRoot: "/unused" })).ok, false);
  const root = await mkdtemp(join(tmpdir(), "mcp-output-"));
  try {
    const file = join(root, "file");
    await writeFile(file, "occupied");
    const result = await adaptMcpResult({ content: [{ type: "text", text: "x".repeat(80000) }] }, { artifactRoot: file });
    assert.equal(result.status, "output_storage_failed");
    assert.equal(result.remoteCompleted, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 51200);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("embedded resources, audio and primitive structured results retain their business data", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-output-"));
  try {
    const input = { content: [
      { type: "resource" as const, resource: { uri: "file:///remote/source.txt", text: "source", mimeType: "text/plain" } },
      { type: "audio" as const, data: Buffer.from("audio").toString("base64"), mimeType: "audio/wav" },
      { type: "resource" as const, resource: { uri: "resource://binary", blob: Buffer.from("blob").toString("base64") } },
      { type: "resource_link" as const, uri: "resource://link", name: "link" },
    ], structuredContent: [1, "two"] };
    const result = await adaptMcpResult(input, { artifactRoot: root });
    assert.match(result.content ?? "", /file:\/\/\/remote\/source.txt/);
    assert.deepEqual(JSON.parse(await readFile(result.path!, "utf8")), input);
    const attachments = result.attachments as { path: string }[];
    assert.deepEqual(await Promise.all(attachments.map(a => readFile(a.path, "utf8"))), ["audio", "blob"]);
    for (const length of [51000, 51200, 51300]) {
      const output = await adaptMcpResult({ content: [{ type: "text", text: "x".repeat(length) }] }, { artifactRoot: root });
      assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 51200);
      if (output.truncated) assert.equal(JSON.parse(await readFile(output.path!, "utf8")).content[0].text.length, length);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
