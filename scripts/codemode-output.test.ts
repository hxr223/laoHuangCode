import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodeModeSandbox } from "@laohuang/codemode";
import { renderCodeModeOutput, createCodeModeImagePort } from "@laohuang/tool-codemode";
import { LocalAttachmentStore } from "@laohuang/attachment-local";
import sharp from "sharp";

test("the model receives explicit text followed by the return value exactly once without deduplication", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const result = await sandbox.execute("text('same'); return 'same';");
    const rendered = await renderCodeModeOutput(result, { outputDirectory: "/unused",
      images: { resolve: async () => { throw new Error("Unexpected image"); } } });
    assert.equal(rendered.ok, true);
    assert.equal(rendered.content, "same\nsame");
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("long explicit output is truncated to the model budget and saved completely", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-output-"));
  const sandbox = new CodeModeSandbox();
  const text = "start" + "x".repeat(5000) + "end";
  try {
    const result = await sandbox.execute(`text(${JSON.stringify(text)}); return 1;`);
    const rendered = await renderCodeModeOutput(result, { outputDirectory: root, maxOutputTokens: 100,
      images: { resolve: async () => { throw new Error("Unexpected image"); } } });
    assert.ok((rendered.content?.length ?? Infinity) <= 400);
    assert.match(rendered.content ?? "", /^start/);
    assert.match(rendered.content ?? "", /end\n1$/);
    assert.equal(rendered.truncated, true);
    assert.equal(typeof rendered.path, "string");
    assert.equal(await readFile(rendered.path!, "utf8"), text + "\n1");
  } finally { await sandbox.close(); await sandbox.drain(); await rm(root, { recursive: true, force: true }); }
});

test("failed scripts return the earlier output together with their error", async () => {
  const sandbox = new CodeModeSandbox();
  try {
    const result = await sandbox.execute("text('before'); throw new Error('failed later');");
    const rendered = await renderCodeModeOutput(result, { outputDirectory: "/unused",
      images: { resolve: async () => { throw new Error("Unexpected image"); } } });
    assert.equal(rendered.ok, false);
    assert.equal(rendered.content, "before");
    assert.match(rendered.error ?? "", /failed later/);
  } finally { await sandbox.close(); await sandbox.drain(); }
});

test("only explicitly selected images become model attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-images-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  const sandbox = new CodeModeSandbox();
  try {
    const inputs = await Promise.all(["red", "blue"].map(async background => ({
      name: background + ".png", data: await sharp({ create: { width: 4, height: 4, channels: 3, background } }).png().toBuffer(),
    })));
    const refs = await store.saveImages(inputs);
    const images = createCodeModeImagePort({ store, references: refs.map(ref => ({ type: "image", ref })) });
    const result = await sandbox.execute(`image({type: 'image', attachment_id: '${refs[1]!.id}'});`);
    const rendered = await renderCodeModeOutput(result, { outputDirectory: root, images });
    assert.equal(rendered.ok, true, rendered.error);
    assert.deepEqual(rendered.attachmentContent?.map(block => block.ref.id), [refs[1]!.id]);
    assert.ok(!JSON.stringify(rendered).includes(refs[0]!.id));
  } finally { await sandbox.close(); await sandbox.drain(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("base64 image output uses real image decoding and enforces reference authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-image-decode-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  try {
    const data = await sharp({ create: { width: 4, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const images = createCodeModeImagePort({ store, references: [] });
    const output = await images.resolve({ data: data.toString("base64"), mimeType: "image/png" });
    assert.equal(output.type, "image");
    if (output.type === "image") assert.deepEqual([output.ref.width, output.ref.height], [4, 2]);
    await assert.rejects(images.resolve({ data: "iVBORw0KGgo=", mimeType: "image/png" }));
    await assert.rejects(images.resolve({ attachment_id: `sha256:${"b".repeat(64)}` }), /not referenced/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("image decoding failure keeps earlier valid output and marks the root as failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-image-failed-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  const sandbox = new CodeModeSandbox();
  try {
    const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const ref = (await store.saveImages([{ data, name: "valid.png" }]))[0]!;
    const images = createCodeModeImagePort({ store, references: [{ type: "image", ref }] });
    const result = await sandbox.execute(`
      text('before'); image({type: 'image', attachment_id: '${ref.id}'});
      image('data:image/png;base64,iVBORw0KGgo='); text('after'); return 3;
    `);
    assert.equal(result.ok, true);
    const rendered = await renderCodeModeOutput(result, { outputDirectory: root, images });
    assert.equal(rendered.ok, false);
    assert.equal(rendered.content, "before");
    assert.deepEqual(rendered.attachmentContent?.map(block => block.ref.id), [ref.id]);
    assert.ok(rendered.error);
  } finally { await sandbox.close(); await sandbox.drain(); store.close(); await rm(root, { recursive: true, force: true }); }
});
