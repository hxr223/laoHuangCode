import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, ToolRuntime, ToolSelection, withToolScriptOutput, codeModeMetadataOf, type ToolSpec } from "@laohuang/tools";
import { toScriptToolValue, ToolScriptError, createCodeModeTool, createCodeModeImagePort, CodeModeWorkerPool } from "@laohuang/tool-codemode";
import { LocalAttachmentStore } from "@laohuang/attachment-local";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { CodingAgent } from "@laohuang/agent-runtime";
import { validatePiToolArguments } from "@laohuang/llm-pi-ai";
import { CancelToken } from "@laohuang/runtime-protocol";

test("cancelling during image finalization keeps the image and rejects successful script store writes", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-finalize-image-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const pool = new CodeModeWorkerPool();
  const token = new CancelToken();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const images = createCodeModeImagePort({ store, references: [] });
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}), outputDirectory: root,
    images: { remember: images.remember, resolve: async (source, signal) => { started.resolve(); await release.promise; return images.resolve(source, signal); } } }) });
  const registry = new ToolRegistry([codeMode]);
  const selected = new ToolSelection().prepare(registry, "only");
  const scope = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).start({
    registry: selected.directTools, callableTools: selected.callableTools, cancelToken: token, executionMode: "parallel",
    toolCalls: [{ id: "root", name: "codemode", arguments: JSON.stringify({ code: `store('noCommit', true); image('data:image/png;base64,${data.toString("base64")}');` }) }],
  });
  try {
    await started.promise; token.cancel("user stopped"); release.resolve();
    const result = (await scope.result).results[0]!;
    assert.equal(result.status, "cancelled");
    assert.equal(result.attachmentContent?.length, 1);
    assert.equal(codeModeMetadataOf(result)?.storeWrites, undefined);
  } finally { release.resolve(); await scope.settled; await codeMode.close(); pool.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancellation preserves an image explicitly emitted before the blocking tool", { timeout: 2000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-cancel-image-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const pool = new CodeModeWorkerPool();
  const token = new CancelToken();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}), outputDirectory: root,
    images: createCodeModeImagePort({ store, references: [] }) }) });
  const registry = new ToolRegistry([codeMode, { spec: { name: "wait", description: "wait", parameters: { type: "object" }, promptGuidelines: [] },
    execute: async () => { started.resolve(); await release.promise; return { ok: true }; } }]);
  const selected = new ToolSelection().prepare(registry, "only");
  const scope = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).start({
    registry: selected.directTools, callableTools: selected.callableTools, cancelToken: token, executionMode: "parallel",
    toolCalls: [{ id: "root", name: "codemode", arguments: JSON.stringify({ code: `image('data:image/png;base64,${data.toString("base64")}'); await tools.wait({});` }) }],
  });
  try {
    await started.promise; token.cancel("user stopped");
    const result = (await scope.result).results[0]!;
    assert.equal(result.status, "cancelled");
    assert.equal(result.attachmentContent?.length, 1);
  } finally { release.resolve(); await scope.settled; await codeMode.close(); pool.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancelling a script retains explicit output without waiting for an uncooperative host call", { timeout: 2000 }, async () => {
  const pool = new CodeModeWorkerPool();
  const token = new CancelToken();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}), outputDirectory: "/unused",
    images: { remember() {}, resolve: async () => { throw new Error("Unexpected image"); } } }) });
  const registry = new ToolRegistry([codeMode, { spec: { name: "wait", description: "wait", parameters: { type: "object" }, promptGuidelines: [] },
    execute: async () => { started.resolve(); await release.promise; return { ok: true, content: "PRIVATE_LATE_RESULT" }; } }]);
  const selected = new ToolSelection().prepare(registry, "only");
  const scope = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).start({
    registry: selected.directTools, callableTools: selected.callableTools, cancelToken: token, executionMode: "parallel",
    toolCalls: [{ id: "root", name: "codemode", arguments: JSON.stringify({ code: "text('before cancellation'); store('noCommit', true); await tools.wait({});" }) }],
  });
  try {
    await started.promise; token.cancel("user stopped");
    const result = (await scope.result).results[0]!;
    assert.equal(result.status, "cancelled");
    assert.equal(result.content, "before cancellation");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_LATE_RESULT"));
  } finally { release.resolve(); await scope.settled; await codeMode.close(); pool.close(); }
});

test("script tool values use declared output structure and preserve null, false and zero", () => {
  const base: ToolSpec = { name: "example", description: "example", parameters: { type: "object" }, promptGuidelines: [] };
  const declared = { ...base, outputSchema: true };
  for (const value of [null, false, 0, { count: 2 }]) {
    const result = withToolScriptOutput({ ok: true, content: "preview" }, { structuredContent: value, text: "full text" });
    assert.deepEqual(toScriptToolValue(declared, result), value);
    assert.equal(toScriptToolValue(base, result), "full text");
  }
  assert.equal(toScriptToolValue(base, { ok: true, content: '{"count":2}' }), '{"count":2}');
  const failed = withToolScriptOutput({ ok: false, error: "denied" }, { structuredContent: { count: 2 } });
  assert.throws(() => toScriptToolValue(declared, failed), ToolScriptError);
  const bash = toScriptToolValue(base, { ok: true, stdout: "out", stderr: "err", exit_code: 0 });
  assert.match(String(bash), /out/); assert.match(String(bash), /err/); assert.match(String(bash), /exit_code.*0/);
});

test("one model tool call composes host tools while keeping intermediate data private", async () => {
  const pool = new CodeModeWorkerPool();
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}),
    outputDirectory: "/unused", images: { remember() {}, resolve: async () => { throw new Error("Unexpected image"); } } }) });
  let reads = 0;
  let requests = 0;
  const privateValue = "PRIVATE_TOOL_VALUE";
  const agent = new CodingAgent({ provider: "test", model: "test", codeMode: "only", validateToolArguments: validatePiToolArguments,
    tools: new ToolRegistry([codeMode, { spec: { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, promptGuidelines: [] },
      execute: args => { assert.equal(args.path, "file.txt"); reads++; return { ok: true, content: privateValue }; } }]),
    modelAdapter: { name: "fake", runAttempt: async request => {
      const call = ++requests === 1;
      return { requestId: request.requestId!, finishReason: call ? "tool-calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 },
        message: { role: "assistant", provider: "test", model: "test", content: call
          ? [{ type: "tool-call", call: { id: "root", name: "codemode", arguments: JSON.stringify({ code: "const data = await tools.read({path: 'file.txt'}); text(data.length); return 'done';" }) } }]
          : [{ type: "text", text: "complete" }] } };
    } },
  });
  try {
    assert.equal(await agent.run("read it"), "complete");
    assert.equal(reads, 1);
    const results = agent.messages.filter(message => message.role === "tool-result");
    assert.equal(results.length, 1);
    assert.ok(!JSON.stringify(results).includes(privateValue));
    assert.equal(JSON.parse(results[0]!.content).content, `${privateValue.length}\ndone`);
  } finally { await codeMode.close(); pool.close(); }
});

test("scripts discover currently callable tools without activating a direct tool path", async () => {
  const pool = new CodeModeWorkerPool();
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}), outputDirectory: "/unused",
    images: { remember() {}, resolve: async () => { throw new Error("Unexpected image"); } } }) });
  const registry = new ToolRegistry([codeMode, { spec: { name: "remote-read", description: "读取远端文件", parameters: { type: "object" },
    promptGuidelines: [], exposure: "deferred" }, execute: () => ({ ok: true, content: "data" }) }]);
  const selection = new ToolSelection();
  const selected = selection.prepare(registry, "only");
  const before = selection.snapshot();
  try {
    const batch = await new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).execute({
      registry: selected.directTools, callableTools: selected.callableTools, cancelToken: null, executionMode: "parallel",
      toolCalls: [{ id: "root", name: "codemode", arguments: JSON.stringify({ code: "text(await searchTools('读取')); text(await tools['remote-read']({}));" }) }],
    });
    assert.equal(batch.results[0]?.ok, true, batch.results[0]?.error);
    assert.match(batch.results[0]?.content ?? "", /remote-read/);
    assert.match(batch.results[0]?.content ?? "", /Promise<string>/);
    assert.match(batch.results[0]?.content ?? "", /data$/);
    assert.deepEqual(selection.snapshot(), before);
    assert.equal((await selected.directTools.execute("remote-read", {})).ok, false);
  } finally { await codeMode.close(); pool.close(); }
});
