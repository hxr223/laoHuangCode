import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [fileURLToPath(new URL("./src/bin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/bin.js", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node22.19",
  format: "esm",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "koffi", "@modelcontextprotocol/client", "@modelcontextprotocol/client/*"],
});
