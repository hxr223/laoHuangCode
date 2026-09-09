import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** JSON persistence only. MCP schema validation belongs to its owning package. */
export class McpConfigStore {
  readonly path: string;
  constructor(path: string) { this.path = path; }

  async read(): Promise<unknown | undefined> {
    let content: string;
    try { content = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot read MCP file: ${this.path}`);
    }
    try { return JSON.parse(content); }
    catch { throw new Error(`Invalid JSON in MCP file: ${this.path}`); }
  }

  async write(document: unknown): Promise<void> {
    let content: string | undefined;
    try { content = JSON.stringify(document, null, 2); }
    catch { throw new Error("MCP storage requires JSON data"); }
    if (content === undefined) throw new Error("MCP storage requires JSON data");
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `.${basename(this.path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${content}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } catch {
      throw new Error(`Cannot save MCP file: ${this.path}`);
    } finally {
      await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    }
  }
}
