import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { AttachmentError, assertFileRef, type FileRef } from "@laohuang/attachment";

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** The name never participates in a storage path. */
export async function writeObject(root: string, source: AsyncIterable<Uint8Array>, name: string, signal?: AbortSignal): Promise<FileRef> {
  const temporary = join(root, "tmp", randomUUID());
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const input of source) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(input);
      bytes += chunk.byteLength;
      if (!Number.isSafeInteger(bytes)) throw new AttachmentError("LIMIT_EXCEEDED", "File is too large");
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    signal?.throwIfAborted();
    await handle.sync();
    const ref: FileRef = {
      id: `sha256:${hash.digest("hex")}`, bytes,
      name: name.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 255),
    };
    const directory = join(root, "objects", ref.id.slice(7, 9));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(join(root, "objects"));
    const target = join(directory, ref.id.slice(7));
    try { await link(temporary, target); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      for await (const _chunk of readObject(root, ref, signal)) { /* Verify an existing object before deduplicating. */ }
    }
    await chmod(target, 0o600);
    await syncDirectory(directory);
    return ref;
  } finally {
    await handle.close();
    await unlink(temporary);
  }
}

export async function* readObject(root: string, ref: FileRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  assertFileRef(ref);
  signal?.throwIfAborted();
  let handle;
  try { handle = await open(join(root, "objects", ref.id.slice(7, 9), ref.id.slice(7)), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    throw new AttachmentError(error instanceof Error && "code" in error && error.code === "ENOENT" ? "NOT_FOUND" : "IO", `Cannot read attachment ${ref.id}`, { cause: error });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== ref.bytes) throw new AttachmentError("CORRUPT", `Attachment size mismatch: ${ref.id}`);
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk);
      if (bytesRead === 0) break;
      const part = chunk.subarray(0, bytesRead);
      bytes += bytesRead;
      hash.update(part);
      yield part;
    }
    if (bytes !== ref.bytes || `sha256:${hash.digest("hex")}` !== ref.id) throw new AttachmentError("CORRUPT", `Attachment digest mismatch: ${ref.id}`);
  } finally { await handle.close(); }
}
