import assert from "node:assert/strict";
import test from "node:test";
import { ModelError } from "@laohuang/llm";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PiModelsStore, type StoredModelCatalogEntry } from "../packages/llm/llm-pi-ai/src/models-store-bridge.ts";

test("model cache round-trips mixed catalogs without requiring chat fields on other types", async () => {
  const models = builtinModels();
  const chat = models.getModels("deepseek")[0]!;
  const image = models.getModelsOfType("image")[0]!;
  const classifier = models.getModelsOfType("classifier", "typesafe")[0]!;
  assert.ok(image);
  assert.ok(classifier);
  let stored: StoredModelCatalogEntry | undefined;
  const bridge = new PiModelsStore({
    read: async () => stored,
    write: async (_provider, entry) => { stored = structuredClone(entry); },
    delete: async () => { stored = undefined; },
  });
  const entry = { models: [chat, image, classifier], checkedAt: 123, lastModified: 100, etag: "fixture" };
  await bridge.write("mixed", entry);
  assert.deepEqual(await bridge.read("mixed"), entry);
  stored = { ...stored!, models: [...stored!.models, { type: "future-model-type" }] };
  assert.deepEqual(await bridge.read("mixed"), entry);
  await bridge.delete("mixed");
  assert.equal(await bridge.read("mixed"), undefined);
});

test("model cache accepts implicit chat type and rejects malformed known model types", async () => {
  const models = builtinModels();
  const chat = { ...models.getModels("deepseek")[0]! };
  delete chat.type;
  let entry: StoredModelCatalogEntry = { models: [chat] };
  const bridge = new PiModelsStore({ read: async () => entry, write: async () => {}, delete: async () => {} });
  assert.equal((await bridge.read("deepseek"))?.models[0]?.type, "chat");
  for (const invalid of [
    { ...chat, reasoning: "yes" },
    { ...chat, maxTokens: 0 },
    { ...chat, input: ["audio"] },
    { ...chat, cost: {} },
    { ...chat, type: "image", output: ["text"] },
    { ...chat, type: "classifier", contextWindow: -1 },
  ]) {
    entry = { models: [invalid] };
    await assert.rejects(bridge.read("deepseek"),
      (error: unknown) => error instanceof ModelError && error.kind === "protocol");
  }
});
