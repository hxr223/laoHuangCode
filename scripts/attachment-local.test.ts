import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import { LocalAttachmentStore } from "@laohuang/attachment-local";
import { AttachmentError, RETENTION_MS, type FileRef, type ImageTarget } from "@laohuang/attachment";

const target: ImageTarget = { maxPixels: 4096, maxDimension: 64, maxBytes: 10000, formats: ["image/png", "image/jpeg", "image/webp"] };
async function* source(data: Uint8Array) { yield data; }
async function bytes(store: LocalAttachmentStore, ref: FileRef) {
  const chunks = [];
  for await (const chunk of store.readFile(ref)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laohuang-attachment-test-"));
  let now = 1_000_000;
  const store = new LocalAttachmentStore({ root, now: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, advance: (ms: number) => { now += ms; } };
}
const png = () => sharp({ create: { width: 128, height: 80, channels: 4, background: { r: 200, g: 50, b: 10, alpha: .5 } } }).png().toBuffer();

test("attachment: streams, deduplicates concurrently and survives reopening", async t => {
  const { root, store } = await fixture(t);
  const data = Buffer.from("verbatim ordinary file\0\xff");
  const [a, b] = await Promise.all([store.saveFile(source(data), "../a"), store.saveFile(source(data), "b")]);
  assert.equal(a.id, b.id); assert.equal(a.name, "a"); assert.equal(b.name, "b");
  assert.deepEqual(await bytes(store, a), data);
  const reopened = new LocalAttachmentStore({ root });
  try { assert.deepEqual(await bytes(reopened, b), data); } finally { reopened.close(); }
  assert.deepEqual(await readdir(join(root, "tmp")), []);
});

test("attachment: original retained, crop/cache/full-resolution/transparency", async t => {
  const { store, root } = await fixture(t);
  const original = await png();
  const [ref] = await store.saveImages([{ data: original, name: "picture.png" }]);
  assert.deepEqual(await bytes(store, ref!), original);
  const resized = await store.prepareImage(ref!, target);
  assert.equal(resized.width, 64); assert.equal(resized.height, 40);
  assert.equal((await sharp(resized.data).metadata()).hasAlpha, true);
  const cropped = await store.prepareImage(ref!, { ...target, region: { x: 10, y: 20, width: 30, height: 40 }, fullResolution: true });
  assert.equal(cropped.width, 30); assert.equal(cropped.height, 40);
  assert.notEqual(cropped.variantId, resized.variantId);
  await assert.rejects(store.prepareImage(ref!, { ...target, fullResolution: true }), /Native resolution/);
  await assert.rejects(store.prepareImage(ref!, { ...target, region: { x: 120, y: 0, width: 30, height: 1 } }), /outside/);
  const cache = join(root, "variants", ref!.id.slice(7), resized.variantId + ".json");
  await writeFile(cache, "corrupt cache");
  assert.deepEqual((await store.prepareImage(ref!, target)).data, resized.data);
  await rm(join(root, "objects", ref!.id.slice(7,9), ref!.id.slice(7)));
  await assert.rejects(store.prepareImage(ref!, target), /Cannot read attachment/);
});

test("attachment: batch validation publishes nothing on invalid MIME or truncated image", async t => {
  const { store, root } = await fixture(t);
  const data = await png();
  await assert.rejects(store.saveImages([{ data, name: "valid" }, { data, name: "invalid", mimeType: "image/jpeg" }]), /MIME/);
  assert.deepEqual(await readdir(join(root, "objects")), []);
  await assert.rejects(store.saveImages([{ data: data.subarray(0, 40), name: "truncated" }]), AttachmentError);
  await assert.rejects(store.saveImages([{ data: Buffer.from("not an image"), name: "fake.png" }]), AttachmentError);
});

test("attachment: image admission count, bytes, dimensions and pixels are hard limits", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-attachment-limits-"));
  const store = new LocalAttachmentStore({ root, imageLimits: { maxImages: 1, maxDimension: 64 } });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const data = await png();
  await assert.rejects(store.saveImages([{ data, name: "1" }, { data, name: "2" }]), /count or byte/);
  await assert.rejects(store.saveImages([{ data, name: "1" }]), /dimension/);
});

test("attachment: oriented crop uses displayed coordinates", async t => {
  const { store } = await fixture(t);
  const data = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const [ref] = await store.saveImages([{ data, name: "oriented.jpg" }]);
  assert.equal(ref!.width, 40); assert.equal(ref!.height, 80);
  const result = await store.prepareImage(ref!, { ...target, region: { x: 0, y: 50, width: 30, height: 20 }, fullResolution: true });
  assert.equal(result.width, 30); assert.equal(result.height, 20);
});

test("attachment: animated original survives and request identifies first frame", async t => {
  const { store } = await fixture(t);
  const pixels = Buffer.alloc(2 * 2 * 3 * 2, 120);
  pixels.fill(240, 12);
  const data = await sharp(pixels, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).gif({ delay: [100, 100] }).toBuffer();
  const [ref] = await store.saveImages([{ data, name: "animated.gif" }]);
  assert.equal(ref!.animated, true);
  assert.deepEqual(await bytes(store, ref!), data);
  assert.match((await store.prepareImage(ref!, target)).note, /first frame/);
});

test("attachment: cancellation, corrupt digest, malformed ID and live close", async t => {
  const { root, store } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(store.saveFile(source(Buffer.from("abc")), "x", controller.signal));
  assert.deepEqual(await readdir(join(root, "tmp")), []);
  const ref = await store.saveFile(source(Buffer.from("abc")), "x");
  await writeFile(join(root, "objects", ref.id.slice(7,9), ref.id.slice(7)), "xyz");
  await assert.rejects(bytes(store, ref), /digest mismatch/);
  await assert.rejects(bytes(store, { ...ref, id: "sha256:../../file" }), /Invalid attachment/);
  const release = store.protect();
  assert.throws(() => store.close(), /operations are active/);
  release();
});

test("attachment: 30-day retention, reference removal resets age, daily success and failure", async t => {
  const { store, advance } = await fixture(t);
  const a = await store.saveFile(source(Buffer.from("a")), "a");
  const b = await store.saveFile(source(Buffer.from("b")), "b");
  store.commit([b], () => {});
  advance(RETENTION_MS - 1);
  assert.deepEqual(store.collectGarbage(() => new Set([b.id])).deleted, []);
  advance(1);
  assert.equal(store.collectGarbage(() => new Set([b.id])).skipped, true);
  assert.deepEqual(store.collectGarbage(() => new Set([b.id]), true).deleted, [a.id]);
  assert.deepEqual(store.collectGarbage(() => new Set(), true).deleted, []);
  advance(RETENTION_MS - 1);
  assert.deepEqual(store.collectGarbage(() => new Set(), true).deleted, []);
  advance(1);
  const deadline = store.nextCollectionAt;
  assert.throws(() => store.collectGarbage(() => { throw new Error("incomplete scan"); }, true), /incomplete scan/);
  assert.equal(store.nextCollectionAt, deadline);
  assert.deepEqual(store.collectGarbage(() => new Set(), true).deleted, [b.id]);
  assert.equal(store.nextCollectionAt, deadline + 1);
});

test("attachment: live operation prevents GC, orphan staging cleaned, variants physically removed", async t => {
  const { root, store, advance } = await fixture(t);
  const [ref] = await store.saveImages([{ data: await png(), name: "x" }]);
  await store.prepareImage(ref!, target);
  advance(RETENTION_MS);
  const release = store.protect();
  assert.equal(store.collectGarbage(() => new Set(), true).skipped, true);
  release();
  await writeFile(join(root, "tmp", "00000000-0000-0000-0000-000000000000"), "staging");
  assert.deepEqual(store.collectGarbage(() => new Set(), true).deleted, [ref!.id]);
  assert.deepEqual(await readdir(join(root, "tmp")), []);
  assert.deepEqual(await readdir(join(root, "variants")), []);
});

test("attachment: extreme aspect ratios still honor exact pixel budgets", async t => {
  const { store } = await fixture(t);
  const data = await sharp({ create: { width: 100, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  const [ref] = await store.saveImages([{ data, name: "thin.png" }]);
  const result = await store.prepareImage(ref!, { ...target, maxPixels: 1 });
  assert.equal(result.width * result.height, 1);
});
