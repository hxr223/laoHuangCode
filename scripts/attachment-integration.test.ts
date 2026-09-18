import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import sharp from "sharp";
import { LocalAttachmentStore } from "@laohuang/attachment-local";
import { RETENTION_MS, type ImageRef } from "@laohuang/attachment";
import { createSessionJournal, SessionManager, scanAttachmentReferences, readSessionFile } from "@laohuang/session-store";
import { ContextBuilder, ConversationHistory, serializeConversation, selectCompactionPlan, DefaultTokenEstimator } from "@laohuang/session-context";
import { ModelError, type ModelAdapter, type ModelCatalog, type ModelRequest, type UserModelMessage } from "@laohuang/llm";
import { PiAiAdapter, prepareRequestImages, toPiContext } from "@laohuang/llm-pi-ai";
import type { Api, Model, Models, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { createReadImageTool } from "@laohuang/tool-fs";
import { NOOP_TOOL_CONTEXT, ToolRegistry } from "@laohuang/tools";
import { HistoryCommitter } from "../packages/core/agent-runtime/src/core/history-committer.ts";
import { createSessionRuntime } from "../apps/cli/src/create-session-runtime.ts";
import { SessionController } from "../apps/cli/src/session-controller.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "laohuang-attachment-integration-"));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot);
  let now = 1_000_000;
  const store = new LocalAttachmentStore({ root: join(root, "attachments"), now: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const data = await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  const ref = (await store.saveImages([{ data, name: "source.png" }]))[0]!;
  return { root, store, ref, data, sessionsRoot, advance: (ms: number) => { now += ms; } };
}
const message = (ref: ImageRef, key = "user-1"): UserModelMessage => ({ role: "user", content: "Describe this", attachmentKey: key, attachments: [{ type: "image", ref }] });
const model: Model<Api> = { id: "vision", name: "vision", provider: "fake", api: "openai-completions", baseUrl: "https://invalid.example", reasoning: false,
  input: ["text", "image"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const request = (messages: ModelRequest["messages"]): ModelRequest => ({ provider: "fake", model: "vision", messages, tools: [] });

test("attachment: user/tool results persist references, fork/clone retain and global scans fail closed", async t => {
  const { store, ref, sessionsRoot, root, advance } = await fixture(t);
  const manager = new SessionManager({ sessionsRoot, appVersion: "test", attachments: store });
  const opened = manager.create({ projectRoot: root, initialCwd: root, provider: "fake", model: "vision", reasoningEffort: "off" });
  const history = ConversationHistory.fromReplay(opened.replay, opened.journal);
  const user = history.appendUser({ message: message(ref), inputEventIds: [], source: "direct" });
  history.offloadImages(["user-1:0"]);
  opened.journal.close();
  const clone = manager.clone({ parentSessionId: opened.header.sessionId });
  const fork = manager.fork({ parentSessionId: opened.header.sessionId, entryId: user.id, mode: "at" });
  await rm(opened.journal.path);
  advance(RETENTION_MS * 2);
  assert.deepEqual(store.collectGarbage(() => scanAttachmentReferences(sessionsRoot), true).deleted, []);
  const replay = readSessionFile(clone.path);
  const entries = replay.items.filter(item => item.kind === "entry");
  const built = new ContextBuilder().build({ entries, currentProvider: "fake", currentModel: "vision" });
  assert.deepEqual((built.messages[0] as UserModelMessage).omittedImageIndexes, [0]);
  assert.match(serializeConversation(entries), /metadata only/);
  assert.doesNotThrow(() => selectCompactionPlan({ entries, retainTokens: 1, estimator: new DefaultTokenEstimator() }));
  await writeFile(join(sessionsRoot, "broken.jsonl"), "broken");
  assert.throws(() => store.collectGarbage(() => scanAttachmentReferences(sessionsRoot), true));
  await rm(join(sessionsRoot, "broken.jsonl"));
  await rm(clone.path); await rm(fork.path);
  assert.deepEqual(store.collectGarbage(() => scanAttachmentReferences(sessionsRoot), true).deleted, []);
  advance(RETENTION_MS);
  assert.deepEqual(store.collectGarbage(() => scanAttachmentReferences(sessionsRoot), true).deleted, [ref.id]);
});

test("attachment: read_image and tool history preserve media without embedding Base64", async t => {
  const { store, root, ref, data, sessionsRoot } = await fixture(t);
  const path = join(root, "picture.png"); await writeFile(path, data);
  const tool = createReadImageTool({ store, projectRoot: root, resolveReference: id => id === ref.id ? ref : undefined });
  await assert.rejects(Promise.resolve().then(() => tool.execute({ attachment_id: "sha256:unknown" }, NOOP_TOOL_CONTEXT)), /not referenced/);
  const result = await tool.execute({ path: "picture.png", region: { x: 0, y: 0, width: 10, height: 10 } }, NOOP_TOOL_CONTEXT);
  assert.equal(result.attachmentContent?.[0]?.ref.id, ref.id);
  const journal = createSessionJournal({ sessionsRoot, attachments: store, projectRoot: root, initialCwd: root, appVersion: "test", provider: "fake", model: "vision" });
  t.after(() => journal.close());
  const history = ConversationHistory.fromReplay(readSessionFile(journal.path), journal);
  const messages: ModelRequest["messages"][number][] = [];
  const committer = new HistoryCommitter({ messages, conversationHistory: history, context: null, cancelToken: null, createCancelled: text => new Error(text) });
  committer.commitToolResults([{ id: "call", name: "read_image", arguments: "{}" }], [result]);
  const msg = messages[0]!;
  assert.equal(msg.role, "tool-result");
  assert.ok("attachments" in msg && msg.attachments?.length === 1);
  assert.ok(!JSON.stringify(msg).includes(data.toString("base64")));
  const prepared = await prepareRequestImages(request(messages), model, { store: () => store });
  const context = toPiContext(request(messages), prepared);
  const output = context.messages[0]!;
  assert.ok(Array.isArray(output.content));
  const image = output.content.find(block => block.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal((await sharp(Buffer.from(image.data, "base64")).metadata()).width, 10);
  assert.equal(scanAttachmentReferences(sessionsRoot).has(ref.id), true);
});

test("attachment: total request eviction protects current images and is durable by occurrence", async t => {
  const { store, ref } = await fixture(t);
  const older = { ...message(ref, "old"), attachments: [{ type: "image" as const, ref }, { type: "image" as const, ref }] };
  const current = message(ref, "new");
  const offloaded = new Set<string>();
  const req = { ...request([older, current]), imageContext: { offloaded, protectedKeys: new Set(["new:0"]), persistOffload: (keys: readonly string[]) => keys.forEach(key => offloaded.add(key)) } };
  const options = { store: () => store, policy: () => ({ target: { maxPixels: 800, maxDimension: 40, maxBytes: 10000, formats: ["image/png" as const] }, maxImages: 1, maxTotalBytes: 10000 }) };
  const first = await prepareRequestImages(req, model, options);
  assert.deepEqual([...offloaded], ["old:0", "old:1"]);
  assert.equal(first.get(current)?.filter(block => block.type === "image").length, 1);
  const second = await prepareRequestImages(req, model, options);
  assert.equal(second.get(older)?.filter(block => block.type === "image").length, 0);
  await assert.rejects(prepareRequestImages({ ...req, imageContext: { ...req.imageContext, offloaded: new Set(), protectedKeys: new Set(["old:0", "old:1", "new:0"]) } }, model, options), /Current-turn images/);
});

test("attachment: adapter sends real decoded image blocks; text-only and corrupt source never open request", async t => {
  const { store, ref, root } = await fixture(t);
  let currentModel = model;
  const contexts: Context[] = [];
  const fake: Pick<Models, "getProviders" | "getProvider" | "getModels" | "getModel" | "streamSimple"> = {
    getProviders: () => [], getProvider: () => undefined, getModels: () => [currentModel], getModel: () => currentModel,
    streamSimple: (_model, context) => {
      contexts.push(context);
      return (async function* (): AsyncGenerator<AssistantMessageEvent> {
        yield { type: "done", reason: "stop", message: { role: "assistant", api: "openai-completions", provider: "fake", model: "vision", content: [{ type: "text", text: "ok" }], timestamp: 0, stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
      })();
    },
  };
  const adapter = new PiAiAdapter({ eligibleProviderIds: new Set(["fake"]), attachments: { store: () => store } }, fake);
  const req = request([message(ref)]);
  assert.throws(() => toPiContext(req), /must be prepared/);
  await adapter.runAttempt(req);
  assert.equal(contexts.length, 1);
  currentModel = { ...model, input: ["text"] };
  await assert.rejects(adapter.runAttempt(req), (error: unknown) => error instanceof ModelError && error.kind === "protocol");
  currentModel = model;
  await writeFile(join(root, "attachments", "objects", ref.id.slice(7,9), ref.id.slice(7)), "corrupt");
  let opened = false;
  await assert.rejects(adapter.runAttempt({ ...req, onRequestOpened: () => { opened = true; } }), /mismatch/);
  assert.equal(opened, false); assert.equal(contexts.length, 1);
});

test("attachment: complete CLI tool loop, durable restore and protected current-turn images", async t => {
  const { store, root, data, sessionsRoot, ref } = await fixture(t);
  await writeFile(join(root, "picture.png"), data);
  const controller = new SessionController({ sessionsRoot, attachments: store, projectRoot: root, initialCwd: root, appVersion: "test", provider: "fake", model: "vision", reasoningEffort: "off" });
  await controller.createNew();
  const catalog: ModelCatalog = {
    listProviders: () => [], getProvider: () => undefined, listModels: () => [], listAvailableModels: async () => [], refresh: async () => {},
    getModel: () => ({ ...model, supportedReasoningEfforts: ["off"] }),
  };
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = { name: "offline-image-loop", runAttempt: async req => {
    requests.push(req);
    const images = await prepareRequestImages(req, model, { store: () => store });
    if (requests.length > 1) assert.equal([...images.values()].flat().filter(block => block.type === "image").length, 1);
    const isTool = requests.length === 1;
    return { requestId: req.requestId ?? "offline", finishReason: isTool ? "tool-calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 },
      message: { role: "assistant", provider: "fake", model: "vision", content: isTool
        ? [{ type: "tool-call", call: { id: "read", name: "read_image", arguments: '{"path":"picture.png"}' } }]
        : [{ type: "text", text: "image received" }] } };
  } };
  const runtime = createSessionRuntime({ attachments: store, modelAdapter: adapter, catalog, route: { provider: "fake", model: "vision", baseUrl: null },
    tools: new ToolRegistry([createReadImageTool({ store, projectRoot: root, resolveReference: () => undefined })]), sessionController: controller,
    projectRoot: root, startupCwd: root, version: "test" });
  try {
    assert.equal(await runtime.agent.run("inspect picture.png"), "image received");
    const toolMessage = requests[1]!.messages.find(msg => msg.role === "tool-result");
    assert.ok(toolMessage && toolMessage.role === "tool-result");
    assert.equal(requests[1]!.imageContext?.protectedKeys.has(`${toolMessage.attachmentKey}:0`), true);
    const sessionId = controller.currentSessionId!;
    await controller.close(); await controller.resume(sessionId); runtime.refreshSession();
    assert.equal(await runtime.agent.run("inspect previous image again"), "image received");
    assert.equal(requests[2]!.imageContext?.protectedKeys.has(`${toolMessage.attachmentKey}:0`), false);
    assert.equal(scanAttachmentReferences(sessionsRoot).has(ref.id), true);
    assert.equal(store.collectGarbage(() => scanAttachmentReferences(sessionsRoot), true).skipped, false, "turn protection is released");
  } finally { await runtime.session.close({ timeoutMs: 1000 }); await runtime.close(); }
});
