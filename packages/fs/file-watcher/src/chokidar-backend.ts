import { FSWatcher } from "chokidar";
import type { WatchChange } from "./types.ts";

export interface BackendCallbacks {
  ready(): void;
  change(change: Extract<WatchChange, { type: "change" }>): void;
  error(error: unknown): void;
}

export interface WatchBackend {
  start(path: string): void;
  close(): Promise<void>;
}

export type BackendFactory = (
  ignored: (path: string) => boolean,
  callbacks: BackendCallbacks,
) => WatchBackend;

export const createChokidarBackend: BackendFactory = (ignored, callbacks) => {
  const watcher = new FSWatcher({
    // Persistent watchers let Chokidar own late native watcher errors. Owners must close.
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    atomic: true,
    ignorePermissionErrors: false,
    ignored: (path) => {
      try { return ignored(path); }
      catch (error) { callbacks.error(error); return true; }
    },
  });
  watcher.once("ready", callbacks.ready);
  watcher.on("error", callbacks.error);
  watcher.on("all", (event, path) => {
    if (event !== "add" && event !== "addDir" && event !== "change" && event !== "unlink" && event !== "unlinkDir") return;
    callbacks.change({
      type: "change", path,
      action: event === "add" || event === "addDir" ? "created" : event === "change" ? "modified" : "deleted",
      kind: event === "addDir" || event === "unlinkDir" ? "directory" : "file",
    });
  });
  return {
    start: (path) => { watcher.add(path); },
    close: async () => {
      // Leave the error listener installed to absorb late OS callbacks during teardown.
      await watcher.close();
    },
  };
};
