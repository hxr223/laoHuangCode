import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ConfigManager, CredentialStore, ModelCatalogStore, CustomModelsStore, defaultConfigPath } from "@laohuang/local-config";
import { createPiAiPlatform } from "@laohuang/llm-pi-ai";
import type { ModelRequest, ModelResult } from "@laohuang/llm";
import { LocalAttachmentStore } from "@laohuang/attachment-local";
import { ToolRegistry, type CodeMode } from "@laohuang/tools";
import { createFileToolDefinitions, createReadImageTool } from "@laohuang/tool-fs";
import { CancelToken } from "@laohuang/runtime-protocol";
import { projectCodeModeStore } from "@laohuang/session-store";
import { SessionController } from "../apps/cli/src/session-controller.ts";
import { createSessionRuntime } from "../apps/cli/src/create-session-runtime.ts";
import { createCodeModeRuntime } from "../apps/cli/src/create-codemode-runtime.ts";
import { EXCLUDED_PROVIDER_IDS } from "../apps/cli/src/provider-policy.ts";
import { startMcpFixture } from "./helpers/mcp-fixture.ts";
import { createMcpService } from "@laohuang/mcp";
import sharp from "sharp";

const enabled = process.env.LAOHUANG_RUN_CODEMODE_E2E === "1";

// Explicitly opt-in: ordinary npm test must never contact a configured provider.
test("configured DeepSeek accepts real Code Mode sessions", { skip: enabled ? false : "set LAOHUANG_RUN_CODEMODE_E2E=1", timeout: 900000 }, async t => {
  const configPath = defaultConfigPath();
  const manager = new ConfigManager(configPath);
  const profiles = manager.listProfiles().filter(profile => profile.provider === "deepseek");
  const profile = profiles.find(item => item.active) ?? profiles[0];
  assert.ok(profile, "No configured DeepSeek profile");
  const route = { provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl };
  const artifactRoot = resolve(".build", `codemode-acceptance-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const store = new LocalAttachmentStore({ root: join(artifactRoot, "attachments") });
  const platform = await createPiAiPlatform({ credentials: new CredentialStore(join(dirname(configPath), "credentials.json")),
    modelCatalogStore: new ModelCatalogStore(join(dirname(configPath), "models.json")), excludedProviderIds: EXCLUDED_PROVIDER_IDS,
    readCustomModels: () => new CustomModelsStore(join(dirname(configPath), "custom-models.json")).read(), attachments: { store: () => store } });
  assert.equal((await platform.auth.status(route.provider)).configured, true, "DeepSeek is not configured");
  const model = platform.catalog.getModel(route.provider, route.model);
  assert.ok(model, "Configured DeepSeek model is not in the local catalog");
  t.diagnostic(`provider=${route.provider} model=${route.model} input=${model.input.join(",")} evidence=${artifactRoot}`);
  const evidence: { name: string; passed: boolean; durationMs: number; requests: number; inputTokens: number; outputTokens: number; error?: string }[] = [];
  let requestCount = 0;

  const scenario = async (name: string, initialMode: CodeMode, check: (fixture: Awaited<ReturnType<typeof openFixture>>) => Promise<void>) => {
    if (process.env.LAOHUANG_CODEMODE_E2E_CASE && process.env.LAOHUANG_CODEMODE_E2E_CASE !== name) return;
    await t.test(name, { timeout: 180000 }, async () => {
      const fixture = await openFixture(name, initialMode);
      const started = performance.now();
      let passed = false;
      let failure: string | undefined;
      try { await check(fixture); passed = true; }
      catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
      finally {
        evidence.push({ name, passed, durationMs: Math.round(performance.now() - started), requests: fixture.requests.length,
          inputTokens: fixture.responses.reduce((sum, result) => sum + result.usage.inputTokens, 0),
          outputTokens: fixture.responses.reduce((sum, result) => sum + result.usage.outputTokens, 0), ...(failure ? { error: failure } : {}) });
        await fixture.close();
        await writeFile(join(artifactRoot, "report.json"), JSON.stringify({ route: { provider: route.provider, model: route.model }, evidence }, null, 2), { mode: 0o600 });
      }
    });
  };

  async function openFixture(name: string, initialMode: CodeMode) {
    const root = await mkdtemp(join(tmpdir(), "laohuang-codemode-live-"));
    for (const [file, values] of Object.entries({ a: [7, 11], b: [13], c: [17] })) await writeFile(join(root, `${file}.json`), JSON.stringify(values.map(value => ({ value, internal: "PRIVATE_INTERMEDIATE_9137" }))));
    const imageRefs = [];
    for (const background of ["red", "blue"]) {
      const data = await sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer();
      await writeFile(join(root, `${background}.png`), data);
      imageRefs.push((await store.saveImages([{ data, name: `${background}.png` }]))[0]!);
    }
    const controller = new SessionController({ sessionsRoot: join(root, "sessions"), attachments: store, projectRoot: root,
      initialCwd: root, appVersion: "acceptance", ...route, reasoningEffort: "off" });
    await controller.createNew();
    const codeMode = createCodeModeRuntime({ configPath: join(root, "config.json"), attachments: store, sessionController: controller });
    const waiting = Promise.withResolvers<void>();
    const registry = new ToolRegistry([codeMode.tool, ...createFileToolDefinitions({ projectRoot: root }),
      createReadImageTool({ store, projectRoot: root, resolveReference: codeMode.resolveReference }),
      { spec: { name: "wait_fixture", description: "Wait thirty seconds; useful for timeout and cancellation acceptance. Takes an empty object.", parameters: { type: "object", additionalProperties: false }, promptGuidelines: [] },
        execute: async (_, context) => { waiting.resolve(); await delay(30000, undefined, { signal: context.signal }); return { ok: true, content: "wait completed" }; } }]);
    const mcpFixture = await startMcpFixture({ protocol: "modern", transport: "http", outputSchema: { type: "object", properties: { value: { type: "number" } } },
      callResult: { content: [{ type: "text", text: "PRIVATE_MCP_TEXT_4321" }], structuredContent: { value: 731 } } });
    const mcp = createMcpService({ servers: [{ id: "fixture", sourcePath: "/acceptance", config: mcpFixture.config }], projectRoot: root,
      version: "acceptance", artifactRoot: join(root, "mcp-artifacts"), env: {}, credentials: { read: async () => undefined, write: async () => {}, remove: async () => {} },
      onToolsChanged: (owner, tools) => registry.replaceOwner(owner, tools), onStatus: () => {} });
    await mcp.start();
    assert.equal(mcp.status()[0]?.state, "ready");
    registry.replaceOwner("acceptance-noise", Array.from({ length: 20 }, (_, index) => ({
      spec: { name: `unused_${index}`, description: "Unrelated acceptance fixture", parameters: { type: "object" }, promptGuidelines: [], exposure: "deferred" as const },
      execute: () => ({ ok: true, content: "unused" }),
    })));
    const requests: ModelRequest[] = [];
    const responses: ModelResult[] = [];
    const runtime = createSessionRuntime({ attachments: store, sessionController: controller, tools: registry, catalog: platform.catalog,
      route, projectRoot: root, startupCwd: root, version: "acceptance", getDefaultCodeMode: () => initialMode,
      modelAdapter: { name: platform.adapter.name, runAttempt: async request => {
        assert.ok(++requestCount <= 60, "Acceptance request budget exceeded (60)");
        requests.push(request);
        const result = await platform.adapter.runAttempt({ ...request, maxOutputTokens: 4096, timeoutMs: 60000 });
        responses.push(result); return result;
      } } });
    runtime.agent.setReasoningEffort("off");
    return { root, runtime, controller, requests, responses, registry, waiting: waiting.promise, imageRefs, mcpCalls: mcpFixture.calls,
      results: () => runtime.agent.messages.filter(message => message.role === "tool-result"),
      calls: () => responses.flatMap(result => result.message.content.flatMap(block => block.type === "tool-call" ? [block.call] : [])),
      async run(prompt: string, cancelToken = new CancelToken()) {
        const timer = setTimeout(() => cancelToken.cancel("Acceptance turn exceeded 120s"), 120000);
        try { return await runtime.agent.run(prompt, { sessionId: controller.currentSessionId!, taskId: name, cancelToken }, { cancelToken }); }
        finally { clearTimeout(timer); }
      },
      async close() {
        await codeMode.close(); await mcp.close(); await mcpFixture.close(); await runtime.session.close({ timeoutMs: 1000 }); await runtime.close();
        const destination = join(artifactRoot, name);
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await cp(join(root, "sessions"), join(destination, "sessions"), { recursive: true });
        await writeFile(join(destination, "model-trace.json"), JSON.stringify({
          requests: requests.map(request => ({ requestId: request.requestId, tools: request.tools.map(tool => tool.name),
            messages: request.messages.filter(message => message.role === "tool-result") })),
          responses: responses.map(response => ({ finishReason: response.finishReason, usage: response.usage,
            content: response.message.content.filter(block => block.type !== "reasoning") })),
        }, null, 2), { mode: 0o600 });
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  try {
    await scenario("only-parallel-private-summary", "only", async fixture => {
      const answer = await fixture.run("使用 codemode，在同一个脚本中用 Promise.all 并行读取 a.json、b.json、c.json。它们是记录数组。只输出总记录数和 value 总和，不输出 internal 或原始记录。最后用中文报告这两个数。不要修改文件。");
      assert.ok(fixture.calls().length > 0);
      assert.ok(fixture.calls().every(call => call.name === "codemode"));
      assert.match(fixture.calls().map(call => call.arguments).join("\n"), /Promise\.all/);
      assert.match(answer, /4/); assert.match(answer, /48/);
      assert.ok(fixture.results().every(result => !result.isError), "Script failed");
      assert.ok(!JSON.stringify(fixture.requests.map(request => request.messages)).includes("PRIVATE_INTERMEDIATE_9137"));
      const entries = fixture.controller.history!.entries().filter(entry => entry.entryType === "tool_result");
      assert.equal(entries.flatMap(entry => entry.payload.executions ?? []).filter(call => call.name === "read").length, 3);
      assert.ok(fixture.requests.every(request => request.tools.every(tool => tool.name === "codemode")));
    });
    await scenario("discover-local-mcp", "only", async fixture => {
      const answer = await fixture.run("通过 codemode 内的 searchTools 搜索 fixture MCP 服务的 echo 工具，再调用找到的工具，参数为空对象。只返回结果的 value 数字，不输出发现列表或原始结果。不要猜工具全名，也不要修改文件。");
      assert.match(fixture.calls().map(call => call.arguments).join("\n"), /searchTools/);
      assert.equal(fixture.mcpCalls(), 1);
      assert.match(answer, /731/);
      assert.ok(fixture.results().every(result => !result.isError));
      assert.ok(!JSON.stringify(fixture.requests.map(request => request.messages)).includes("PRIVATE_MCP_TEXT_4321"));
    });
    await scenario("off-on-only-mode-switch", "off", async fixture => {
      await fixture.run("直接调用 read 读取 b.json，报告其中 value，不要调用 codemode。");
      assert.ok(fixture.calls().some(call => call.name === "read"));
      assert.ok(!fixture.calls().some(call => call.name === "codemode"));
      assert.ok(fixture.requests.every(request => !request.tools.some(tool => tool.name === "codemode")));
      fixture.runtime.setCodeMode("on");
      const afterOff = fixture.responses.length;
      await fixture.run("这次明确使用 codemode 脚本读取 c.json，返回第一个记录的 value。");
      assert.ok(fixture.responses.slice(afterOff).some(response => response.message.content.some(block => block.type === "tool-call" && block.call.name === "codemode")));
      const onRequest = fixture.requests.at(-1)!;
      assert.ok(onRequest.tools.some(tool => tool.name === "read"));
      assert.ok(onRequest.tools.some(tool => tool.name === "codemode"));
      assert.ok(onRequest.tools.some(tool => tool.name === "tool_search"));
      fixture.runtime.setCodeMode("only");
      const afterOn = fixture.responses.length;
      const answer = await fixture.run("读取 a.json，返回所有 value 的和。");
      assert.match(answer, /18/);
      assert.ok(fixture.responses.slice(afterOn).flatMap(response => response.message.content.filter(block => block.type === "tool-call")).every(block => block.call.name === "codemode"));
      assert.deepEqual(fixture.requests.at(-1)!.tools.map(tool => tool.name), ["codemode"]);
    });
    await scenario("store-resume", "only", async fixture => {
      await fixture.run("用 codemode 的 store 将 cursor 保存为 37。返回已保存即可，不要创建文件。");
      assert.equal(projectCodeModeStore(fixture.controller.history!.entries()).cursor, 37);
      const id = fixture.controller.currentSessionId!;
      await fixture.controller.close(); await fixture.controller.resume(id); fixture.runtime.refreshSession();
      const afterResume = fixture.responses.length;
      const answer = await fixture.run("用 codemode 的 load 从会话 store 读取 cursor，给它加 5，再用 store 保存到原键。返回计算结果，不要从对话直接作答。");
      assert.match(answer, /42/);
      assert.equal(projectCodeModeStore(fixture.controller.history!.entries()).cursor, 42);
      assert.match(fixture.responses.slice(afterResume).flatMap(response => response.message.content.flatMap(block => block.type === "tool-call" ? [block.call.arguments] : [])).join("\n"), /load/);
      assert.equal(fixture.runtime.agent.getCodeMode(), "only");
    });
    await scenario("caught-tool-error", "only", async fixture => {
      const answer = await fixture.run("可以先发现工具，但实际读取必须在同一个 codemode 脚本内完成：先用 read 尝试 absent.json，在脚本内用 try/catch 捕获错误并 text('caught')，然后读取 b.json，返回第一个记录的 value。不要让脚本因文件不存在而失败后再起一个脚本补救。");
      assert.match(answer, /13/);
      assert.ok(fixture.results().every(result => !result.isError));
      assert.match(fixture.results().map(result => result.content).join("\n"), /caught/);
      const executions = fixture.controller.history!.entries().filter(entry => entry.entryType === "tool_result").flatMap(entry => entry.payload.executions ?? []);
      assert.equal(fixture.controller.history!.entries().filter(entry => entry.entryType === "tool_result" && entry.payload.executions?.some(call => call.name === "read")).length, 1);
      assert.ok(executions.some(call => call.name === "read" && call.status === "failed"));
      assert.ok(executions.some(call => call.name === "read" && call.status === "completed"));
    });
    await scenario("output-budget", "only", async fixture => {
      await fixture.run("用一个 codemode 脚本测试输出截断：首行 @options 的 max_output_tokens 设为 200；text 输出 'BEGIN-' 加 5000 个 x 再加 '-END'，不要把完整字符串写进代码，使用 repeat；不要调用其他工具。脚本结束后报告结果里的完整输出路径，不要读取这个文件，不要再次调用 codemode。");
      const result = fixture.results().find(message => message.toolName === "codemode")!;
      const payload = JSON.parse(result.content);
      assert.equal(payload.ok, true); assert.equal(payload.truncated, true);
      assert.ok(payload.content.length <= 800);
      assert.ok((await readFile(payload.path, "utf8")).startsWith("BEGIN-" + "x".repeat(5000) + "-END"));
    });
    await scenario("selected-image", "only", async fixture => {
      const answer = await fixture.run("使用一个 codemode 脚本：先用 read_image 读取 red.png 和 blue.png，但只 image() 展示 blue.png 的返回对象，red.png 不要输出。不要输出图片的 base64。然后回答你实际收到的图片是什么颜色。");
      const results = fixture.results().filter(message => message.toolName === "codemode");
      assert.equal(results.flatMap(message => message.attachments ?? []).length, 1);
      assert.deepEqual(results.flatMap(message => message.attachments ?? []).map(block => block.ref.id), [fixture.imageRefs[1]!.id]);
      assert.ok(fixture.requests.some(request => request.messages.some(message => message.role === "tool-result" && message.attachments?.some(block => block.ref.id === fixture.imageRefs[1]!.id))));
      assert.ok(!fixture.requests.some(request => request.messages.some(message => message.role === "tool-result" && message.attachments?.some(block => block.ref.id === fixture.imageRefs[0]!.id))));
      assert.match(answer, /蓝|blue/i);
    });
    await scenario("script-timeout-no-state", "only", async fixture => {
      await fixture.run("测试一次脚本超时：用 codemode，首行 @options 设置 timeout_ms 为 300；脚本中 store('failedWrite', 1)，text('before timeout')，然后 await tools.wait_fixture({})。超时是预期结果，不要 catch、不要重试。最后报告超时即可。");
      assert.ok(fixture.results().some(message => JSON.parse(message.content).status === "timeout"));
      assert.equal(projectCodeModeStore(fixture.controller.history!.entries()).failedWrite, undefined);
      assert.equal(fixture.calls().filter(call => call.name === "codemode").length, 1);
    });
    await scenario("cancel-then-next-turn", "only", async fixture => {
      const token = new CancelToken();
      const running = fixture.run("用 codemode 调用 wait_fixture 等待。调用前 store('cancelledWrite', 1)，text('before cancellation')。不要使用定时器，不要重试。", token);
      const outcome = running.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
      await Promise.race([fixture.waiting, outcome.then(() => { throw new Error("Model finished without starting the cancellation fixture"); })]);
      const started = performance.now(); token.cancel("acceptance stop");
      const cancelled = await outcome;
      assert.equal(cancelled.ok, false);
      if (!cancelled.ok) assert.match(cancelled.error instanceof Error ? cancelled.error.message : String(cancelled.error), /cancel|acceptance stop/i);
      assert.ok(performance.now() - started < 2000, "Cancellation was not prompt");
      assert.equal(projectCodeModeStore(fixture.controller.history!.entries()).cancelledWrite, undefined);
      assert.ok(fixture.results().some(message => JSON.parse(message.content).status === "cancelled"));
      const answer = await fixture.run("上次任务已取消。现在用 codemode 读取 c.json，返回第一条 value。");
      assert.match(answer, /17/);
    });
    assert.ok(evidence.length > 0, "Unknown LAOHUANG_CODEMODE_E2E_CASE");
  } finally { store.close(); }
});
