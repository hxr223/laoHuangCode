import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
const files: Record<string, string> = {};
const rejected: string[] = [];
let size = 0,
  count = 0;
function walk(directory: string, prefix: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = join(directory, entry.name),
      name = prefix + entry.name;
    if (++count > 500) throw new Error("Artifact file count exceeds 500");
    if (entry.isSymbolicLink()) {
      rejected.push(name);
      continue;
    }
    if (entry.isDirectory()) walk(path, name + "/");
    else if (entry.isFile()) {
      size += lstatSync(path).size;
      if (size > 10 * 1024 * 1024)
        throw new Error("Artifact snapshot exceeds 10 MiB");
      files[name] = readFileSync(path).toString("base64");
    } else rejected.push(name);
  }
}
walk("/workspace", "");
process.stdout.write(JSON.stringify({ files, rejected }));
