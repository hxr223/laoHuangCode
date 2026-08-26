import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ModelCatalogStore } from "../packages/storage/local-config/src/index.ts";

async function withTempDir(
  run: (directory: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-models-test-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("dynamic model entries round-trip through a private atomic file", async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, "models.json");
    const store = new ModelCatalogStore(path);
    const entry = {
      models: [{
        id: "radius-model",
        name: "Radius Model",
        api: "pi-messages",
        provider: "radius",
        baseUrl: "https://radius.example/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }],
      checkedAt: 1234,
      etag: "etag-1",
    };

    await store.write("radius", entry);

    assert.deepEqual(await new ModelCatalogStore(path).read("radius"), entry);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    await store.delete("radius");
    assert.equal(await store.read("radius"), undefined);
  });
});
