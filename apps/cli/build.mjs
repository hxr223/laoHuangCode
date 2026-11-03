import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: {
    bin: fileURLToPath(new URL("./src/bin.ts", import.meta.url)),
    "codemode-worker": fileURLToPath(new URL("./src/codemode-worker.ts", import.meta.url)),
  },
  outdir: fileURLToPath(new URL("./dist", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node22.19",
  format: "esm",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as createBundleRequire } from 'node:module';\nconst require = createBundleRequire(import.meta.url);" },
  external: ["sharp", "quickjs-wasi", "quickjs-wasi/*", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "koffi", "@modelcontextprotocol/client", "@modelcontextprotocol/client/*"],
});
