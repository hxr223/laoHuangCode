import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import {
  AttachmentStore, AttachmentError, DEFAULT_IMAGE_LIMITS, RETENTION_MS, CLEANUP_INTERVAL_MS, assertFileRef, assertAttachmentContent,
  type AttachmentId, type CollectionResult, type FileRef, type ImageInput, type ImageLimits, type ImageRef, type ImageTarget, type PreparedImage,
} from "@laohuang/attachment";
import { writeObject, readObject } from "./object-store.ts";
import { inspectImage, renderImage, validateTarget } from "./image.ts";

export interface LocalAttachmentOptions {
  readonly root: string;
  readonly imageLimits?: Partial<ImageLimits>;
  readonly compressionConcurrency?: number;
  readonly now?: () => number;
}
interface ObjectRow { id: AttachmentId; created: number; unreferenced: number | null; referenced: number }

/** SQLite coordinates collectors, active uses and synchronous journal commits across local processes. */
export class LocalAttachmentStore extends AttachmentStore {
  readonly root: string;
  readonly imageLimits: ImageLimits;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly concurrency: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly operations = new Set<string>();
  private closed = false;

  constructor(options: LocalAttachmentOptions) {
    super();
    this.root = resolve(options.root);
    this.now = options.now ?? Date.now;
    this.imageLimits = Object.freeze({ ...DEFAULT_IMAGE_LIMITS, ...options.imageLimits });
    this.concurrency = options.compressionConcurrency ?? 2;
    if (![...Object.values(this.imageLimits), this.concurrency].every(n => Number.isSafeInteger(n) && n > 0) || this.concurrency > 8) throw new AttachmentError("LIMIT_EXCEEDED", "Invalid attachment configuration");
    for (const path of [this.root, join(this.root, "objects"), join(this.root, "tmp"), join(this.root, "variants")]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(join(this.root, "metadata.sqlite"));
    chmodSync(join(this.root, "metadata.sqlite"), 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY, created INTEGER NOT NULL, unreferenced INTEGER, referenced INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  }

  private transaction<T>(action: () => T): T {
    if (this.closed) throw new AttachmentError("CLOSED", "Attachment store is closed");
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  protect(): () => void {
    const id = randomUUID();
    this.transaction(() => this.db.prepare("INSERT INTO operations VALUES (?, ?)").run(id, process.pid));
    this.operations.add(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.closed) this.db.prepare("DELETE FROM operations WHERE id=?").run(id);
      this.operations.delete(id);
    };
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await task(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }

  async saveFile(source: AsyncIterable<Uint8Array>, name: string, signal?: AbortSignal): Promise<FileRef> {
    const release = this.protect();
    try {
      const ref = await writeObject(this.root, source, name, signal);
      this.transaction(() => this.db.prepare("INSERT OR IGNORE INTO objects VALUES (?, ?, ?, 0)").run(ref.id, this.now(), this.now()));
      return ref;
    } finally { release(); }
  }

  async *readFile(ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    const release = this.protect();
    try { yield* readObject(this.root, ref, signal); } finally { release(); }
  }

  async saveImages(inputs: readonly ImageInput[], signal?: AbortSignal): Promise<readonly ImageRef[]> {
    const release = this.protect();
    try {
      if (inputs.length > this.imageLimits.maxImages || inputs.reduce((sum, input) => sum + input.data.byteLength, 0) > this.imageLimits.maxBatchBytes) throw new AttachmentError("LIMIT_EXCEEDED", "Image batch exceeds count or byte limits");
      // Own the bytes so a caller cannot mutate a validated image before it is saved.
      const owned = inputs.map(input => ({ ...input, data: Buffer.from(input.data) }));
      const inspected = [];
      for (const input of owned) {
        signal?.throwIfAborted();
        inspected.push(await this.limited(() => inspectImage(input, this.imageLimits)));
      }
      const refs: ImageRef[] = [];
      for (const [index, input] of owned.entries()) {
        const ref = await this.saveFile((async function* () { yield input.data; })(), input.name, signal);
        refs.push({ ...ref, ...inspected[index]! });
      }
      return refs;
    } finally { release(); }
  }

  async prepareImage(ref: ImageRef, target: ImageTarget, signal?: AbortSignal): Promise<PreparedImage> {
    assertAttachmentContent({ type: "image", ref });
    validateTarget(target);
    const release = this.protect();
    try {
      if (ref.bytes > this.imageLimits.maxBytes) throw new AttachmentError("LIMIT_EXCEEDED", "Stored image exceeds configured source limit");
      const chunks: Uint8Array[] = [];
      for await (const chunk of this.readFile(ref, signal)) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      return await this.limited(async () => {
        const actual = await inspectImage({ data, name: ref.name, mimeType: ref.mimeType }, this.imageLimits);
        if (actual.width !== ref.width || actual.height !== ref.height || actual.animated !== ref.animated) throw new AttachmentError("CORRUPT", "Image reference metadata mismatch");
        const variantId = createHash("sha256").update(JSON.stringify({ version: 1, id: ref.id,
          pixels: target.maxPixels, dimension: target.maxDimension, bytes: target.maxBytes,
          formats: target.formats, region: target.region ?? null, full: target.fullResolution ?? false })).digest("hex");
        const directory = join(this.root, "variants", ref.id.slice(7));
        const path = join(directory, variantId + ".json");
        try {
          const raw: unknown = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
          const cached = raw as Partial<Omit<PreparedImage, "data">> & { data?: string; digest?: string };
          if (cached.variantId === variantId && typeof cached.data === "string" && typeof cached.digest === "string" && typeof cached.note === "string") {
            const bytes = Buffer.from(cached.data, "base64");
            if (bytes.length <= target.maxBytes && createHash("sha256").update(bytes).digest("hex") === cached.digest) {
              const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: target.maxPixels });
              const meta = await decoder.metadata();
              if (meta.width === cached.width && meta.height === cached.height &&
                Math.max(meta.width, meta.height) <= target.maxDimension && meta.width * meta.height <= target.maxPixels &&
                cached.mimeType === `image/${meta.format}` && target.formats.includes(cached.mimeType)) {
                await decoder.stats();
                signal?.throwIfAborted();
                return { data: bytes, width: meta.width, height: meta.height, mimeType: cached.mimeType, variantId, note: cached.note };
              }
            }
          }
        } catch (error) { signal?.throwIfAborted(); /* Missing or invalid derived data is rebuilt from the verified original. */ }
        const result = await renderImage(data, ref, target, variantId, signal);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(this.root, "tmp", randomUUID());
        try {
          await writeFile(temporary, JSON.stringify({ ...result, data: Buffer.from(result.data).toString("base64"), digest: createHash("sha256").update(result.data).digest("hex") }), { flag: "wx", mode: 0o600 });
          await rename(temporary, path);
        } finally { await unlink(temporary).catch((error: unknown) => { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }); }
        return result;
      });
    } finally { release(); }
  }

  commit<T>(refs: readonly FileRef[], write: () => T): T {
    return this.transaction(() => {
      for (const ref of refs) {
        assertFileRef(ref);
        const path = join(this.root, "objects", ref.id.slice(7, 9), ref.id.slice(7));
        if (!existsSync(path)) throw new AttachmentError("NOT_FOUND", `Attachment missing before commit: ${ref.id}`);
        const info = lstatSync(path);
        if (!info.isFile() || info.size !== ref.bytes) throw new AttachmentError("CORRUPT", "Attachment changed before commit");
        this.db.prepare("INSERT OR IGNORE INTO objects VALUES (?, ?, NULL, 1)").run(ref.id, this.now());
        this.db.prepare("UPDATE objects SET referenced=1, unreferenced=NULL WHERE id=?").run(ref.id);
      }
      const result = write();
      if (result instanceof Promise) throw new TypeError("Attachment commit callback must be synchronous");
      return result;
    });
  }

  collectGarbage(references: () => ReadonlySet<AttachmentId>, force = false): CollectionResult {
    return this.transaction(() => {
      const now = this.now();
      const last = this.db.prepare("SELECT value FROM settings WHERE key='lastCleanup'").get() as { value: number } | undefined;
      if (!force && last && now - last.value < CLEANUP_INTERVAL_MS) return { deleted: [], skipped: true };
      const operations = this.db.prepare("SELECT id,pid FROM operations").all() as unknown as Array<{ id: string; pid: number }>;
      for (const operation of operations) {
        let alive = true;
        try { process.kill(operation.pid, 0); }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") alive = false; }
        if (alive) return { deleted: [], skipped: true };
        this.db.prepare("DELETE FROM operations WHERE id=?").run(operation.id);
      }
      const retained = references(); // Failure aborts the entire deletion phase.
      // Recover objects published immediately before a process died while committing metadata.
      for (const prefix of readdirSync(join(this.root, "objects"))) {
        if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
        for (const hash of readdirSync(join(this.root, "objects", prefix))) {
          if (!/^[a-f0-9]{64}$/.test(hash) || !hash.startsWith(prefix)) continue;
          const info = lstatSync(join(this.root, "objects", prefix, hash));
          if (!info.isFile()) throw new AttachmentError("CORRUPT", "Unexpected attachment object type");
          this.db.prepare("INSERT OR IGNORE INTO objects VALUES (?, ?, ?, 0)").run(`sha256:${hash}`, info.mtimeMs, info.mtimeMs);
        }
      }
      const rows = this.db.prepare("SELECT * FROM objects").all() as unknown as ObjectRow[];
      const deleted: AttachmentId[] = [];
      for (const row of rows) {
        if (retained.has(row.id)) {
          this.db.prepare("UPDATE objects SET referenced=1, unreferenced=NULL WHERE id=?").run(row.id);
          continue;
        }
        if (row.unreferenced === null) {
          this.db.prepare("UPDATE objects SET unreferenced=? WHERE id=?").run(now, row.id);
          continue;
        }
        if (now - row.unreferenced < RETENTION_MS) continue;
        rmSync(join(this.root, "variants", row.id.slice(7)), { recursive: true, force: true });
        rmSync(join(this.root, "objects", row.id.slice(7, 9), row.id.slice(7)), { force: true });
        this.db.prepare("DELETE FROM objects WHERE id=?").run(row.id);
        deleted.push(row.id);
      }
      // No live process is using this store, so staging files belong to interrupted operations.
      for (const file of readdirSync(join(this.root, "tmp"))) {
        if (/^[a-f0-9-]{36}$/.test(file)) rmSync(join(this.root, "tmp", file), { force: true });
      }
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES ('lastCleanup', ?)").run(now);
      return { deleted, skipped: false };
    });
  }

  get nextCollectionAt(): number {
    if (this.closed) throw new AttachmentError("CLOSED", "Attachment store is closed");
    const row = this.db.prepare("SELECT value FROM settings WHERE key='lastCleanup'").get() as { value: number } | undefined;
    return row ? row.value + CLEANUP_INTERVAL_MS : 0;
  }

  close(): void {
    if (this.closed) return;
    if (this.active || this.waiting.length || this.operations.size) throw new AttachmentError("IO", "Cannot close while attachment operations are active");
    for (const id of this.operations) this.db.prepare("DELETE FROM operations WHERE id=?").run(id);
    this.operations.clear();
    this.db.close();
    this.closed = true;
  }
}
