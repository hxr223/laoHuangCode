import { readFile } from "node:fs/promises";

/** User-owned definitions, separate from the machine-written model catalog cache. */
export class CustomModelsStore {
  readonly path: string;

  constructor(path: string) { this.path = path; }

  async read(): Promise<unknown | undefined> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot read custom models file: ${this.path}`);
    }
    try {
      return JSON.parse(content);
    } catch {
      // JSON parser errors can echo credential-like values from malformed input.
      throw new Error(`Invalid JSON in custom models file: ${this.path}`);
    }
  }
}
