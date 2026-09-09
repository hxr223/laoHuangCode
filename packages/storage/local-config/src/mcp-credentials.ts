import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpConfigStore } from "./mcp-config.ts";

const operations = new Map<string, Promise<void>>();

/** Isolated from the model API-key document; keys are never used as paths. */
export class McpCredentialFileStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  private path(key: string): string {
    return join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  async read(key: string): Promise<unknown | undefined> {
    const path = this.path(key);
    await operations.get(path);
    return new McpConfigStore(path).read();
  }
  write(key: string, value: unknown): Promise<void> {
    return this.mutate(key, path => new McpConfigStore(path).write(value));
  }
  remove(key: string): Promise<void> {
    return this.mutate(key, async path => {
      try { await unlink(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot remove MCP credentials"); }
    });
  }
  private mutate(key: string, work: (path: string) => Promise<void>): Promise<void> {
    const path = this.path(key);
    const operation = (operations.get(path) ?? Promise.resolve()).then(() => work(path));
    const settled = operation.then(() => {}, () => {});
    operations.set(path, settled);
    void settled.then(() => { if (operations.get(path) === settled) operations.delete(path); });
    return operation;
  }
}
