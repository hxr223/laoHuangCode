import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SkillRegistry, type SkillEntry, type SkillProvider } from "@laohuang/skill";
import { FileSystemSkillProvider, parseSkill, parseSkillDirs, skillRoots } from "@laohuang/skill-filesystem";
import { SkillSession, parseSkillCommand } from "@laohuang/tool-skill";
import { createWatchService, type WatchService, type WatchHandle, type WatchChange, type WatchFailure } from "@laohuang/file-watcher";
import { CodingAgent } from "@laohuang/agent-runtime";
import { ToolRegistry } from "@laohuang/tools";
import { CancelToken, makePromptIntent } from "@laohuang/runtime-protocol";
import { AgentSession, routeHumanIntent } from "@laohuang/session-runtime";
import { ContextBuilder, ContextUsage, DefaultTokenEstimator, serializeConversation, selectCompactionPlan } from "@laohuang/session-context";
import { parseSessionItem, type SessionEntry } from "@laohuang/session-store";
import type { ModelAdapter, ModelMessage, ModelRequest } from "@laohuang/llm";
import { createSkillRuntime } from "../apps/cli/src/create-skill-runtime.ts";
import { CommandRegistry } from "../apps/cli/src/commands.ts";
import { runPlainSessionRepl } from "../apps/cli/src/repl.ts";
import { PlainEventSink, PromptEofError } from "@laohuang/tui";
import { PlainCommandPresenter } from "../apps/cli/src/plain-command-presenter.ts";

function document(name: string, body = "Original instructions", description = "Review changes"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}
async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }

class FakeWatch implements WatchService {
  handles: (WatchHandle & { path: string; emit(change: WatchChange): void; fail(): void })[] = [];
  watch(path: string): WatchHandle {
    const listeners = new Set<(change: WatchChange) => void | Promise<void>>();
    const errors = new Set<(failure: WatchFailure) => void | Promise<void>>();
    let closed = false;
    const handle: WatchHandle & { path: string; emit(change: WatchChange): void; fail(): void } = {
      path, ready: Promise.resolve(), get state() { return closed ? "closed" : "watching"; }, lastError: undefined,
      onDidChange: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
      onError: listener => { errors.add(listener); return { dispose: () => { errors.delete(listener); } }; },
      dispose: async () => { closed = true; listeners.clear(); errors.clear(); },
      emit: change => { for (const listener of listeners) void listener(change); },
      fail: () => { for (const listener of errors) void listener({ path, error: new Error("EIO"), recoverable: true, source: "backend" }); },
    };
    this.handles.push(handle); return handle;
  }
  emit(path: string): void {
    let actual = path;
    try { actual = realpathSync(path); } catch { try { actual = join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1)); } catch {} }
    for (const handle of this.handles) for (const candidate of new Set([path, actual])) if (dirname(candidate) === handle.path || candidate === handle.path) handle.emit({ type: "change", path: candidate, kind: "file", action: "modified" });
  }
  async close(): Promise<void> { await Promise.all(this.handles.map(handle => handle.dispose())); }
}

test("Skill parsing requires both fields, handles YAML, and preserves command arguments", () => {
  assert.equal(parseSkill(document("review")).name, "review");
  assert.equal(parseSkill("---\nname: review\ndescription: >\n  Review\n  changes\n---\nbody").description, "Review changes");
  for (const value of ["body", "---\nname: review\n---\nbody", document("bad/name"), document("review", "", "[]")]) assert.throws(() => parseSkill(value));
  assert.deepEqual(parseSkillCommand('/skill:review "a\nb"  \n'), { name: "review", arguments: '"a\nb"  \n' });
  assert.equal(parseSkillCommand("Please use /skill:review"), null);
  assert.deepEqual(parseSkillDirs(["~/skills", "../shared", "../shared"], "/config/laohuang/config.json", "/home/u"), ["/home/u/skills", "/config/shared"]);
  assert.throws(() => parseSkillDirs([false], "/config.json", "/home"));
  assert.throws(() => parseSkillDirs(["https://example.com/skills"], "/config.json", "/home"));
  assert.deepEqual(skillRoots("/project", "/home", ["/extra"]).map(root => root.path), ["/project/.laohuang/skills", "/project/.agents/skills", "/extra", "/home/.laohuang/skills", "/home/.agents/skills"]);
});

test("Registry caches complete snapshots, preserves on failure, and disposes registered providers", async () => {
  let reads = 0; let complete = true; let closed = false; let changed = () => {};
  const entry: SkillEntry = { name: "review", description: "Review", providerId: "fake", sourceId: "a", identity: "file", location: "a", priority: 1, locator: "file" };
  const provider: SkillProvider = { id: "fake", list: async () => { reads++; return { complete, entries: [entry, { ...entry, location: "alias" }] }; },
    load: async value => ({ entry: value, body: "body", bodyHash: "hash", resourceBase: "base" }),
    onChange: listener => { changed = listener; return () => { changed = () => {}; }; }, close: async () => { closed = true; } };
  const registry = new SkillRegistry(); const unregister = registry.register(provider);
  const [a, b] = await Promise.all([registry.snapshot(), registry.snapshot()]);
  assert.equal(a, b); assert.equal(a.entries.length, 1);
  await registry.snapshot(); assert.equal(reads, 1);
  complete = false; changed(); const failed = await registry.snapshot();
  assert.equal(failed.complete, false); assert.equal(failed.entries, a.entries);
  await assert.rejects(registry.load("review"), /incomplete/);
  await unregister(); assert.equal(closed, true); assert.equal((await registry.snapshot()).entries.length, 0);
  await registry.close(); await assert.rejects(registry.snapshot(), /closed/);
});

test("Filesystem discovery boundaries, precedence, fresh body, invalid file removal and cache reuse", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-")); const watcher = new FakeWatch();
  const reports: string[] = []; const registry = new SkillRegistry(message => reports.push(message));
  const source = new FileSystemSkillProvider(watcher, message => reports.push(message));
  t.after(async () => { await registry.close(); await watcher.close(); await rm(root, { recursive: true, force: true }); });
  const high = join(root, "high"), low = join(root, "low");
  await put(join(high, "review.md"), document("review", "high"));
  await put(join(low, "review/SKILL.md"), document("review", "low"));
  await put(join(high, "nested/deep/SKILL.md"), document("deep"));
  await put(join(high, "nested/helper.md"), document("not-discovered"));
  await put(join(high, "bad/SKILL.md"), "bad");
  await put(join(high, "bad/inside/SKILL.md"), document("hidden-by-boundary"));
  await put(join(high, ".hidden/SKILL.md"), document("hidden"));
  await put(join(high, "node_modules/SKILL.md"), document("dependency"));
  source.setRoots([{ path: low, priority: 2 }, { path: high, priority: 1 }]); registry.register(source);
  const snapshot = await registry.snapshot();
  assert.deepEqual(snapshot.entries.map(entry => entry.name), ["deep", "review"]);
  assert.equal((await registry.load("review")).body, "high");
  const handles = watcher.handles.length;
  await registry.snapshot(); assert.equal(watcher.handles.length, handles);
  await put(join(high, "review.md"), document("review", "fresh"));
  assert.equal((await registry.load("review")).body, "fresh");
  await put(join(high, "review.md"), "broken"); watcher.emit(join(high, "review.md"));
  assert.equal((await registry.load("review")).body, "low");
  assert.ok(reports.some(report => report.includes("collision")));
  assert.ok(reports.some(report => report.includes("ignored")));
  await rm(low, { recursive: true }); watcher.emit(low);
  assert.deepEqual((await registry.snapshot()).entries.map(entry => entry.name), ["deep"]);
  // A non-directory source is an I/O fault, not a confirmed empty catalog.
  await rename(high, `${high}-saved`); await writeFile(high, "not a directory"); watcher.emit(high);
  assert.equal((await registry.snapshot()).complete, false);
  assert.deepEqual((await registry.snapshot()).entries.map(entry => entry.name), ["deep"]);
});

test("Public watcher tracks external symlink targets, retargeting, missing targets and close", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-watch-"));
  const watcher = createWatchService({ coalesceMs: 5 }); const registry = new SkillRegistry(); const source = new FileSystemSkillProvider(watcher);
  t.after(async () => { await registry.close(); await watcher.close(); await rm(root, { recursive: true, force: true }); });
  const skills = join(root, "skills"), target = join(root, "external"), other = join(root, "other");
  await mkdir(skills); await put(join(target, "SKILL.md"), document("review", "one"));
  await symlink(target, join(skills, "review")); await symlink(target, join(skills, "alias"));
  await symlink(skills, join(skills, "cycle"));
  source.setRoots([{ path: skills, priority: 1 }]); registry.register(source);
  assert.equal((await registry.snapshot()).entries.length, 1);
  const session = new SkillSession(registry); session.selectSession("a");
  const activation = await session.prepareInput("/skill:review"); session.committed([activation]);
  const initial = await session.prepareContext([]);
  await put(join(target, "SKILL.md"), document("review", "two"));
  await eventually(async () => (await session.prepareContext(initial)).some(message => message.skillContext?.kind === "invalidation"));
  assert.equal((await registry.load("review")).body, "two");
  await put(join(other, "SKILL.md"), document("different"));
  await rm(join(skills, "review")); await symlink(other, join(skills, "review"));
  await eventually(async () => (await registry.snapshot()).entries.length === 2);
  await rm(join(skills, "alias")); await rm(other, { recursive: true });
  await eventually(async () => (await registry.snapshot()).entries.length === 0);
  await put(join(other, "SKILL.md"), document("reborn"));
  await eventually(async () => (await registry.snapshot()).entries[0]?.name === "reborn");
  await registry.close(); await watcher.close(); session.close();
  await assert.rejects(registry.load("reborn"), /closed/);
});

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await delay(30); }
  assert.fail("Expected filesystem update did not arrive");
}

test("Skill messages dedupe by visible catalog, hash changes, committed receipts, and session", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-context-")); const watcher = new FakeWatch(); const registry = new SkillRegistry();
  const source = new FileSystemSkillProvider(watcher); source.setRoots([{ path: root, priority: 1 }]); registry.register(source);
  const session = new SkillSession(registry); session.selectSession("a");
  t.after(async () => { session.close(); await registry.close(); await rm(root, { recursive: true, force: true }); });
  const path = join(root, "review.md"); await put(path, document("review"));
  const initial = await session.prepareContext([]); assert.equal(initial.length, 1);
  assert.deepEqual(await session.prepareContext(initial), []);
  assert.equal((await session.prepareContext([])).length, 1); // compaction removed the structured source
  const activation = await session.prepareInput('/skill:review "raw\nargs"  '); session.committed([activation]);
  assert.match(activation.content, /"raw\nargs"  $/);
  watcher.emit(path); assert.deepEqual(await session.prepareContext(initial), []);
  await put(path, document("review", "changed")); watcher.emit(path);
  const notice = await session.prepareContext(initial); assert.equal(notice[0]?.skillContext?.kind, "invalidation");
  assert.ok(!notice[0]?.content.includes("\nchanged"));
  assert.deepEqual(await session.prepareContext([...initial, ...notice]), []);
  const reloaded = await session.prepareInput("/skill:review"); session.committed([reloaded]);
  assert.deepEqual(await session.prepareContext(initial), []);
  session.selectSession("b"); await put(path, document("review", "again")); watcher.emit(path);
  assert.deepEqual(await session.prepareContext(initial), []);
  session.selectSession("a"); assert.equal((await session.prepareContext(initial))[0]?.skillContext?.kind, "invalidation");
  await put(path, "invalid"); watcher.emit(path);
  const removed = await session.prepareContext(initial); assert.equal(removed.length, 1); assert.match(removed[0]!.content, /No skills/);
  await assert.rejects(session.prepareInput("/skill:review"));
  await put(path, document("review")); watcher.emit(path);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(session.prepareInput("/skill:review", cancelled.signal));
});

test("CLI skillDirs automatically updates completions and preserves old sources on malformed config without a reload command", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-config-")); const watcher = new FakeWatch(); const reports: string[] = [];
  const configPath = join(root, "config/config.json"), extra = join(root, "extra");
  await put(configPath, JSON.stringify({ skillDirs: ["../extra"] })); await put(join(extra, "review.md"), document("review"));
  const runtime = await createSkillRuntime({ configPath, projectRoot: join(root, "project"), home: join(root, "home"), watcher, report: message => reports.push(message) });
  t.after(async () => { await runtime.close(); await watcher.close(); await rm(root, { recursive: true, force: true }); });
  const commands = new CommandRegistry(); await runtime.attachCommands(commands);
  assert.deepEqual(commands.complete("/skill:", { state: "IDLE" }).map(item => item.value), ["/skill:review"]);
  assert.equal(commands.get("/reload"), undefined);
  assert.equal("reload" in runtime, false);
  await put(configPath, "bad json"); watcher.emit(configPath);
  await eventually(async () => reports.some(message => message.includes("Cannot read Skill configuration")));
  assert.equal((await runtime.registry.snapshot()).entries.length, 1);
  await put(configPath, JSON.stringify({ skillDirs: [false] })); watcher.emit(configPath);
  await eventually(async () => reports.some(message => message.includes("skillDirs")));
  assert.equal((await runtime.registry.snapshot()).entries.length, 1);
  await put(configPath, "{}"); watcher.emit(configPath);
  await eventually(async () => commands.complete("/skill:", { state: "IDLE" }).length === 0);
  assert.equal((await commands.execute("/reload")).status, "not_found");
  await runtime.close(); assert.ok(watcher.handles.every(handle => handle.state === "closed"));
});

test("Agent loads skills as tools, announces between pairs, and rejects explicit failures before model calls", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-agent-")); const watcher = new FakeWatch(); const registry = new SkillRegistry();
  const source = new FileSystemSkillProvider(watcher); source.setRoots([{ path: root, priority: 1 }]); registry.register(source);
  const skills = new SkillSession(registry); const path = join(root, "review.md"); await put(path, document("review"));
  t.after(async () => { skills.close(); await registry.close(); await rm(root, { recursive: true, force: true }); });
  const requests: ModelRequest[] = [];
  const adapter: ModelAdapter = { name: "fake", runAttempt: async request => {
    requests.push(request);
    if (requests.length === 2) {
      const messages = request.messages;
      const call = messages.findIndex(message => message.role === "assistant");
      assert.equal(messages[call + 1]?.role, "tool-result");
      await put(path, document("review", "new body")); watcher.emit(path);
    }
    return { requestId: request.requestId!, message: { role: "assistant", provider: "fake", model: "fake", content: requests.length === 1 ? [{ type: "tool-call", call: { id: "call", name: "skill", arguments: JSON.stringify({ name: "review" }) } }] : [{ type: "text", text: "done" }] }, finishReason: requests.length === 1 ? "tool-calls" : "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const agent = new CodingAgent({ modelAdapter: adapter, model: "fake", provider: "fake", tools: new ToolRegistry([skills.tool]), resources: skills });
  await assert.rejects(agent.run("/skill:missing")); assert.equal(requests.length, 0); assert.equal(agent.messages.length, 1);
  await agent.run("review changes"); assert.equal(requests.length, 2);
  assert.equal(requests[0]!.messages.filter(message => message.role === "user" && message.skillContext?.kind === "catalog").length, 1);
  await agent.run("continue");
  assert.equal(requests[2]!.messages.at(-1)?.role, "user");
  assert.ok(requests[2]!.messages.some(message => message.role === "user" && message.skillContext?.kind === "invalidation"));
  const token = new CancelToken(); token.cancel("cancelled"); await assert.rejects(agent.run("/skill:review", null, { cancelToken: token }));
  assert.equal(requests.length, 3);
});

test("Skill metadata survives journal schema, context projection, compaction and token accounting", () => {
  const entry = parseSessionItem({ schemaVersion: 1, kind: "entry", entryType: "skill_context", sessionId: "s", seq: 1, id: "e1", timestamp: "now", payload: { message: { role: "user", content: "Skill catalog text", skillContext: { kind: "catalog", key: "[]" } } } }) as SessionEntry;
  const built = new ContextBuilder().build({ entries: [entry], currentProvider: "fake", currentModel: "fake" });
  assert.deepEqual(built.sourceEntryIds, ["e1"]); assert.equal(built.messages[0]?.role, "user");
  assert.ok(new ContextUsage([entry]).tokens! > 0);
  assert.match(serializeConversation([entry]), /Skill catalog text/);
  assert.equal(selectCompactionPlan({ entries: [entry], retainTokens: 100, estimator: new DefaultTokenEstimator() }).retainedEntries.length, 1);
});

test("Raw skill inputs bypass slash parsing and queue batches resolve their individual commands at execution", async () => {
  const raw = '/skill:review "unclosed\n  raw  ';
  const action = routeHumanIntent(makePromptIntent(raw, "editor"), "idle"); assert.equal(action.type, "prompt");
  let release!: () => void;
  const first = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const observed: { content: string; parts: readonly string[] | undefined }[] = [];
  const session = new AgentSession(async (content, context) => {
    observed.push({ content, parts: context.inputParts() });
    if (observed.length === 1) await first;
    return "done";
  }, { semanticClassifier: () => { throw new Error("Skill routing must not use a model"); } });
  try {
    await session.submitInput("first");
    assert.equal((await session.submitAction(action) as { queued: boolean }).queued, true);
    await session.submitInput("/skill:second args"); release();
    assert.equal(await session.waitForIdle(2000), true);
    assert.deepEqual(observed[1]?.parts, [raw, "/skill:second args"]);
  } finally { release(); await session.close(); }
});

test("Agent restores a compacted Skill catalog and bounds an impossible context budget", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-budget-")); const watcher = new FakeWatch(); const registry = new SkillRegistry();
  const source = new FileSystemSkillProvider(watcher); source.setRoots([{ path: root, priority: 1 }]); registry.register(source);
  await put(join(root, "review.md"), document("review")); const skills = new SkillSession(registry);
  t.after(async () => { skills.close(); await registry.close(); await rm(root, { recursive: true, force: true }); });
  let calls = 0; let preparation = 0;
  const model: ModelAdapter = { name: "fake", runAttempt: async request => {
    calls++;
    assert.ok(request.messages.some(message => message.role === "user" && message.skillContext?.kind === "catalog"));
    request.onRequestOpened?.();
    return { requestId: request.requestId!, message: { role: "assistant", provider: "fake", model: "fake", content: [{ type: "text", text: "done" }] }, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const dropCatalog = (messages: readonly ModelMessage[]) => messages.filter(message => !(message.role === "user" && message.skillContext?.kind === "catalog"));
  const agent = new CodingAgent({ modelAdapter: model, model: "fake", provider: "fake", tools: new ToolRegistry([skills.tool]), resources: skills,
    contextGovernor: { prepare: async ({ messages }) => ({ messages: ++preparation === 1 ? dropCatalog(messages) : messages }) } });
  await agent.run("review"); assert.equal(preparation, 2); assert.equal(calls, 1);
  const impossible = new CodingAgent({ modelAdapter: model, model: "fake", provider: "fake", tools: new ToolRegistry([skills.tool]), resources: skills,
    contextGovernor: { prepare: async ({ messages }) => ({ messages: dropCatalog(messages) }) } });
  await assert.rejects(impossible.run("review"), /cannot fit/); assert.equal(calls, 1);
  const token = new CancelToken();
  const cancelled = new CodingAgent({ modelAdapter: model, model: "fake", provider: "fake", tools: new ToolRegistry([skills.tool]), resources: skills,
    contextGovernor: { prepare: async ({ messages }) => { token.cancel("before request"); return { messages }; } } });
  await assert.rejects(cancelled.run("/skill:review", null, { cancelToken: token })); assert.equal(calls, 1);
  await put(join(root, "review.md"), document("review", "changed")); watcher.emit(join(root, "review.md"));
  const messages = await skills.prepareContext([]);
  assert.equal(messages.filter(message => message.skillContext?.kind === "invalidation").length, 0);
});

test("A queued Skill batch expands every original command without parsing ordinary quoted text", async t => {
  const root = await mkdtemp(join(tmpdir(), "laohuang-skill-batch-")); const watcher = new FakeWatch(); const registry = new SkillRegistry();
  const source = new FileSystemSkillProvider(watcher); source.setRoots([{ path: root, priority: 1 }]); registry.register(source);
  const skills = new SkillSession(registry);
  t.after(async () => { skills.close(); await registry.close(); await rm(root, { recursive: true, force: true }); });
  await put(join(root, "review.md"), document("review", "current review"));
  await put(join(root, "other.md"), document("other", "current other"));
  const result = await skills.prepareInput("combined queue", undefined, ["/skill:review a\nb  ", "quote /skill:missing", "/skill:other c"]);
  assert.match(result.content, /current review/); assert.match(result.content, /a\nb  /); assert.match(result.content, /current other/);
  assert.equal(result.skillContext?.skills?.length, 2);
  skills.committed([result]);
  await put(join(root, "other.md"), document("other", "updated other")); watcher.emit(join(root, "other.md"));
  assert.ok((await skills.prepareContext([])).some(message => message.skillContext?.kind === "invalidation"));
});

test("Plain REPL can retry a retained Skill draft without trimming multiline arguments", async () => {
  const raw = "/skill:review line1\nline2  "; const submitted: string[] = [];
  const session = new AgentSession(async content => { submitted.push(content); return "done"; });
  const output: string[] = []; const sink = new PlainEventSink(message => output.push(message));
  let reads = 0;
  const result = await runPlainSessionRepl(session, {
    presenter: new PlainCommandPresenter({ output: message => output.push(message), input: async () => "", secretInput: async () => "" }),
    suggestCommand: () => null, sink,
    inputFn: async () => { if (++reads === 1) return ""; throw new PromptEofError(); },
    recoverInput: () => raw,
  });
  assert.equal(result, true); assert.deepEqual(submitted, [raw]);
});
