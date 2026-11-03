import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAttachmentStore } from "@laohuang/attachment-local";
import { ToolRegistry, ToolRuntime, ToolSelection } from "@laohuang/tools";
import { createCodeModeTool, CodeModeWorkerPool } from "@laohuang/tool-codemode";
import { createMcpService } from "@laohuang/mcp";
import { validatePiToolArguments } from "@laohuang/llm-pi-ai";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";
import { CancelToken } from "@laohuang/runtime-protocol";
import { createReadImageTool } from "@laohuang/tool-fs";
import sharp from "sharp";
import { projectCodeModeStore } from "@laohuang/session-store";
import type { ModelCatalog, ModelRequest, ModelResult } from "@laohuang/llm";
import { SessionController } from "../apps/cli/src/session-controller.ts";
import { createSessionRuntime } from "../apps/cli/src/create-session-runtime.ts";
import { createCodeModeRuntime } from "../apps/cli/src/create-codemode-runtime.ts";

const model = { provider: "test", id: "test", name: "test", reasoning: true, supportedReasoningEfforts: ["off", "high"] as const,
  input: ["text", "image"] as const, contextWindow: 128000, maxTokens: 8192 };
const catalog: ModelCatalog = { listProviders: () => [], getProvider: () => undefined, listModels: () => [model],
  listAvailableModels: async () => [model], getModel: () => model, refresh: async () => {} };

function reply(request: ModelRequest, code?: string): ModelResult {
  return { requestId: request.requestId!, finishReason: code ? "tool-calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 },
    message: { role: "assistant", provider: "test", model: "test", content: code
      ? [{ type: "tool-call", call: { id: request.requestId!, name: "codemode", arguments: JSON.stringify({ code }) } }]
      : [{ type: "text", text: "done" }] } };
}

test("real scripts obey only/on/off with twenty deferred tools and retain loaded direct tools", async () => {
  const pool = new CodeModeWorkerPool();
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}), outputDirectory: "/unused",
    images: { remember() {}, resolve: async () => { throw new Error("Unexpected image"); } } }) });
  const registry = new ToolRegistry([codeMode, ...Array.from({ length: 20 }, (_, i) => ({
    spec: { name: `remote_${i}`, description: `remote_${i}`, parameters: { type: "object" }, promptGuidelines: [], exposure: "deferred" as const },
    execute: () => ({ ok: true, content: String(i) }),
  }))]);
  const selection = new ToolSelection();
  const runtime = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments });
  const run = async (mode: "off" | "on" | "only", name: string, args: Record<string, unknown>) => {
    const view = selection.prepare(registry, mode);
    selection.apply(view.update);
    const batch = await runtime.execute({ registry: view.directTools, callableTools: view.callableTools,
      cancelToken: null, executionMode: "parallel", toolCalls: [{ id: "root", name, arguments: JSON.stringify(args) }] });
    selection.apply({ toolsAdded: view.pending(), toolsRemoved: [] });
    return batch.results[0]!;
  };
  try {
    assert.equal((await run("only", "tool_search", { query: "remote_0" })).ok, false);
    assert.equal((await run("only", "remote_0", {})).ok, false);
    const script = "return await Promise.all(ALL_TOOLS.map(t => tools[t.name]({})));";
    const result = await run("only", "codemode", { code: script });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(JSON.parse(result.content!), Array.from({ length: 20 }, (_, i) => String(i)));
    assert.equal((await run("on", "tool_search", { query: "remote_0", limit: 1 })).ok, true);
    assert.equal((await run("on", "remote_0", {})).content, "0");
    assert.equal((await run("on", "codemode", { code: "return await tools.remote_0({});" })).content, "0");
    assert.equal((await run("off", "codemode", { code: "return 1" })).ok, false);
    assert.equal((await run("off", "remote_0", {})).content, "0");
  } finally { await codeMode.close(); pool.close(); }
});

test("local MCP results cross the real script bridge using declared schemas and catchable errors", async () => {
  for (const variant of ["structured", "text", "failed"] as const) {
    const fixture = await startMcpFixture({ protocol: "modern", transport: "http",
      ...(variant !== "text" ? { outputSchema: { type: "object", properties: {} } } : {}),
      callResult: { content: [{ type: "text", text: "PRIVATE_TEXT" }], structuredContent: { count: 0, allowed: false, empty: null }, isError: variant === "failed" } });
    const pool = new CodeModeWorkerPool();
    const codeMode = createCodeModeTool({ workerPool: pool, bindSession: () => ({ readStore: () => ({}), outputDirectory: "/unused",
      images: { remember() {}, resolve: async () => { throw new Error("Unexpected image"); } } }) });
    const registry = new ToolRegistry([codeMode]);
    const service = createMcpService({ servers: [{ id: "test", sourcePath: "/config", config: fixture.config }], projectRoot: process.cwd(), version: "test", artifactRoot: "/unused", env: {},
      credentials: { read: async () => undefined, write: async () => {}, remove: async () => {} },
      onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: () => {} });
    try {
      await service.start();
      const view = new ToolSelection().prepare(registry, "only");
      const name = view.callableTools.definitions[0]!.name;
      const result = await new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).execute({
        registry: view.directTools, callableTools: view.callableTools, cancelToken: null, executionMode: "parallel",
        toolCalls: [{ id: "root", name: "codemode", arguments: JSON.stringify({ code: `try { return await tools[${JSON.stringify(name)}]({}); } catch (error) { return 'caught'; }` }) }],
      });
      assert.equal(result.results[0]?.ok, true, result.results[0]?.error);
      if (variant === "structured") assert.deepEqual(JSON.parse(result.results[0]!.content!), { count: 0, allowed: false, empty: null });
      else if (variant === "text") assert.match(result.results[0]!.content!, /^PRIVATE_TEXT\n/);
      else assert.equal(result.results[0]?.content, "caught");
      assert.equal(fixture.calls(), 1);
    } finally { await service.close(); await fixture.close(); await codeMode.close(); pool.close(); }
  }
});

test("two session scripts share Worker capacity and a third can cancel while queued", { timeout: 3000 }, async () => {
  const pool = new CodeModeWorkerPool();
  const bothStarted = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const owners: string[] = [];
  const codeMode = createCodeModeTool({ workerPool: pool, bindSession: context => {
    owners.push(context.sessionId!);
    return { readStore: () => ({ owner: context.sessionId }), outputDirectory: "/unused",
      images: { remember() {}, resolve: async () => { throw new Error("Unexpected image"); } } };
  } });
  const registry = new ToolRegistry([codeMode, { spec: { name: "wait", description: "wait", parameters: { type: "object" }, promptGuidelines: [] },
    execute: async () => { if (++calls === 2) bothStarted.resolve(); await release.promise; return { ok: true }; } }]);
  const view = new ToolSelection().prepare(registry, "only");
  const runtime = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments });
  const run = (id: string, token: CancelToken | null = null) => runtime.start({ registry: view.directTools, callableTools: view.callableTools,
    cancelToken: token, executionMode: "parallel", createExecutionContext: (_, cancel) => ({ sessionId: id, signal: cancel?.signal,
      isCancelled: () => cancel?.isCancelled() ?? false, cancellationReason: "cancelled", publish: () => { if (id === "third") queued.resolve(); } }),
    toolCalls: [{ id, name: "codemode", arguments: JSON.stringify({ code: "await tools.wait({}); return load('owner');" }) }],
  });
  const first = run("first"); const second = run("second");
  let third: ReturnType<typeof run> | undefined;
  try {
    await bothStarted.promise;
    const token = new CancelToken(); third = run("third", token);
    await queued.promise; assert.equal(calls, 2);
    token.cancel("cancel queued script");
    assert.equal((await third.result).results[0]?.status, "cancelled");
    release.resolve();
    assert.equal((await first.result).results[0]?.content, "first");
    assert.equal((await second.result).results[0]?.content, "second");
    assert.equal(calls, 2);
    assert.deepEqual(owners, ["first", "second", "third"]);
  } finally { release.resolve(); await Promise.all([first.settled, second.settled, third?.settled]); await codeMode.close(); pool.close(); }
});

test("CLI composition preserves script state through turns and durable session restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-cli-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  const controller = new SessionController({ sessionsRoot: join(root, "sessions"), attachments: store, projectRoot: root,
    initialCwd: root, appVersion: "test", provider: "test", model: "test", reasoningEffort: "high" });
  await controller.createNew();
  const codeMode = createCodeModeRuntime({ configPath: join(root, "config.json"), attachments: store, sessionController: controller });
  let requests = 0;
  let defaultMode: "on" | "only" = "only";
  const runtime = createSessionRuntime({ attachments: store, sessionController: controller, tools: new ToolRegistry([codeMode.tool]),
    catalog, route: { provider: "test", model: "test", baseUrl: null }, projectRoot: root, startupCwd: root, version: "test",
    getDefaultCodeMode: () => defaultMode,
    modelAdapter: { name: "fake", runAttempt: async request => reply(request, ++requests % 2
      ? "store('count', (load('count') ?? 0) + 1); text(load('count'));" : undefined) },
  });
  try {
    assert.equal(runtime.agent.getCodeMode(), "only");
    await runtime.agent.run("first");
    await runtime.agent.run("second");
    assert.deepEqual(projectCodeModeStore(controller.history!.entries()), { count: 2 });
    const id = controller.currentSessionId!;
    await controller.close(); await controller.resume(id); runtime.refreshSession();
    await runtime.agent.run("restored");
    assert.deepEqual(projectCodeModeStore(controller.history!.entries()), { count: 3 });
    const result = runtime.agent.messages.filter(message => message.role === "tool-result").at(-1)!;
    assert.equal(JSON.parse(result.content).content, "3");
    assert.ok(!JSON.stringify(runtime.agent.messages).includes("storeWrites"));
    defaultMode = "on";
    await controller.createNew(); runtime.refreshSession();
    assert.equal(runtime.agent.getCodeMode(), "on");
    await controller.resume(id); runtime.refreshSession();
    assert.equal(runtime.agent.getCodeMode(), "only");
  } finally {
    await codeMode.close(); await runtime.session.close({ timeoutMs: 1000 }); await runtime.close(); store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI restore authorizes private image references while only selected images reach the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "codemode-cli-images-"));
  const store = new LocalAttachmentStore({ root: join(root, "attachments") });
  const controller = new SessionController({ sessionsRoot: join(root, "sessions"), attachments: store, projectRoot: root,
    initialCwd: root, appVersion: "test", provider: "test", model: "test", reasoningEffort: "high" });
  await controller.createNew();
  for (const background of ["red", "blue"]) await writeFile(join(root, `${background}.png`),
    await sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer());
  const codeMode = createCodeModeRuntime({ configPath: join(root, "config.json"), attachments: store, sessionController: controller });
  const readImage = createReadImageTool({ store, projectRoot: root, resolveReference: codeMode.resolveReference });
  let requests = 0;
  let scripts = 0;
  const runtime = createSessionRuntime({ attachments: store, sessionController: controller, tools: new ToolRegistry([codeMode.tool, readImage]),
    catalog, route: { provider: "test", model: "test", baseUrl: null }, projectRoot: root, startupCwd: root, version: "test", getDefaultCodeMode: () => "only",
    modelAdapter: { name: "fake", runAttempt: async request => reply(request, ++requests % 2
      ? ++scripts === 1
        ? "const red = await tools.read_image({path:'red.png'}); store('privateImage', red.attachment_id); const blue = await tools.read_image({path:'blue.png'}); image(blue);"
        : "image(await tools.read_image({attachment_id:load('privateImage')}));"
      : undefined) },
  });
  try {
    await runtime.agent.run("select blue");
    const privateId = projectCodeModeStore(controller.history!.entries()).privateImage;
    const first = runtime.agent.messages.filter(message => message.role === "tool-result").at(-1)!;
    assert.equal(first.attachments?.length, 1);
    assert.notEqual(first.attachments?.[0]?.ref.id, privateId);
    assert.equal(controller.history!.entries().filter(entry => entry.entryType === "tool_result").at(-1)!.payload.codeMode?.internalAttachments?.length, 2);
    const id = controller.currentSessionId!;
    await controller.close(); await controller.resume(id); runtime.refreshSession();
    await runtime.agent.run("select restored red");
    const second = runtime.agent.messages.filter(message => message.role === "tool-result").at(-1)!;
    assert.equal(second.isError, false);
    assert.deepEqual(second.attachments?.map(block => block.ref.id), [privateId]);
  } finally {
    await codeMode.close(); await runtime.session.close({ timeoutMs: 1000 }); await runtime.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});
