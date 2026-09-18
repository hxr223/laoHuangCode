import { mkdirSync } from "node:fs";
import { CLEANUP_INTERVAL_MS, type CollectionResult } from "@laohuang/attachment";
import { LocalAttachmentStore, type LocalAttachmentOptions } from "@laohuang/attachment-local";
import { scanAttachmentReferences } from "@laohuang/session-store";

export function createAttachmentRuntime(options: LocalAttachmentOptions & {
  readonly sessionsRoot: string;
  readonly onError: (error: unknown) => void;
}) {
  mkdirSync(options.sessionsRoot, { recursive: true, mode: 0o700 });
  const store = new LocalAttachmentStore(options);
  const now = options.now ?? Date.now;
  let closed = false;
  let timer: ReturnType<typeof setTimeout>;
  const collect = (force = false): CollectionResult => store.collectGarbage(
    () => scanAttachmentReferences(options.sessionsRoot), force,
  );
  const run = (): void => {
    if (closed) return;
    try { collect(); } catch (error) { options.onError(error); }
    finally { if (!closed) timer = setTimeout(run, CLEANUP_INTERVAL_MS).unref(); }
  };
  timer = setTimeout(run, Math.max(0, store.nextCollectionAt - now())).unref();
  return {
    store, collect,
    close(): void {
      clearTimeout(timer);
      store.close();
      closed = true;
    },
  };
}
