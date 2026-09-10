import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CliUsageError, parseArgs } from "../apps/cli/src/args.ts";
import { SessionController } from "../apps/cli/src/session-controller.ts";
import { readSessionFile, sessionTitleAt } from "@laohuang/session-store";

test("parseArgs accepts continue and resume but rejects them together", () => {
  const continued = parseArgs(["--continue"]);
  assert.equal(continued.kind, "run");
  assert.equal(continued.kind === "run" ? continued.args.continueSession : false, true);

  const resumed = parseArgs(["--resume", "abc"]);
  assert.equal(resumed.kind, "run");
  assert.equal(resumed.kind === "run" ? resumed.args.resumeSessionId : null, "abc");

  assert.throws(() => parseArgs(["--continue", "--resume", "abc"]), CliUsageError);
});

test("session controller creates, continues latest, and rejects project mismatch", async () => {
  const controller = new SessionController({
    sessionsRoot: makeTempRoot(),
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  await controller.createNew();
  const first = controller.currentSessionId;
  await controller.close();
  await controller.createNew();
  const second = controller.currentSessionId;
  await controller.close();

  await controller.continueLatest();
  assert.equal(controller.currentSessionId, second);
  await controller.close();

  const mismatch = new SessionController({
    sessionsRoot: controller.sessionsRoot,
    projectRoot: "/tmp/other",
    initialCwd: "/tmp/other",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  await assert.rejects(mismatch.resume(first), /project root mismatch/);
});

test("session controller reports unknown session ids", async () => {
  const controller = new SessionController({
    sessionsRoot: makeTempRoot(),
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  await assert.rejects(controller.resume("missing"), /unknown session/);
});

test("session controller wires manual compaction to active history", async () => {
  const controller = new SessionController({
    sessionsRoot: makeTempRoot(),
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  await controller.createNew();
  controller.history?.appendUser({
    message: { role: "user", content: "hello" },
    inputEventIds: [],
    source: "direct",
  });

  let compacted = false;
  controller.setCompactor(async () => {
    compacted = true;
    controller.history?.appendCompaction({
      summary: "summary",
      summarizedFromSeq: 1,
      summarizedThroughSeq: 2,
      retainedFromSeq: 3,
      tokensBefore: 100,
      retainedTokens: 20,
      summaryInputTokens: 10,
      summaryOutputTokens: 5,
      provider: "pi-ai",
      model: "gpt-test",
      trigger: "manual",
    });
    return { summary: "summary", inputTokens: 10, outputTokens: 5 };
  });

  await controller.compact();

  assert.equal(compacted, true);
  assert.equal(controller.history?.entries().at(-1)?.entryType, "compaction");
  await controller.close();
});

function makeTempRoot(): string {
  const root = join(tmpdir(), `laohuang-session-resume-${process.pid}-${Date.now()}-${Math.random()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

test("session names persist through resume and continue without changing message history", async (t) => {
  const root = makeTempRoot();
  const controller = new SessionController({
    sessionsRoot: root, projectRoot: "/tmp/project", initialCwd: "/tmp/project",
    appVersion: "0.8.3", provider: "pi-ai", model: "gpt-test", reasoningEffort: "high",
  });
  t.after(async () => { await controller.close(); rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => controller.setName("no session"), /active session/i);
  await controller.createNew();
  const id = controller.currentSessionId;
  assert.ok(id);
  assert.equal(controller.currentTitle, null);
  controller.history!.appendUser({ message: { role: "user", content: "hello" }, inputEventIds: [], source: "direct" });
  const entries = controller.history!.entries();
  controller.setName("  MCP 接入设计  ");
  const nextSeq = controller.currentJournal!.nextSeq;
  controller.setName("MCP 接入设计");
  assert.equal(controller.currentJournal!.nextSeq, nextSeq);
  assert.deepEqual(controller.history!.entries(), entries);
  assert.equal(controller.currentTitle, "MCP 接入设计");
  assert.equal(controller.list().find((item) => item.sessionId === id)?.title, "MCP 接入设计");
  await controller.close();
  assert.equal(controller.currentTitle, null);
  await controller.resume(id);
  assert.equal(controller.currentTitle, "MCP 接入设计");
  await controller.close();
  await controller.continueLatest();
  assert.equal(controller.currentTitle, "MCP 接入设计");
  await controller.createNew();
  assert.equal(controller.currentTitle, null);
});

test("a failed rename does not update memory or pretend the disk write was reverted", async (t) => {
  const root = makeTempRoot();
  const controller = new SessionController({
    sessionsRoot: root, projectRoot: "/tmp/project", initialCwd: "/tmp/project",
    appVersion: "0.8.3", provider: "pi-ai", model: "gpt-test", reasoningEffort: "high",
  });
  t.after(async () => { t.mock.restoreAll(); await controller.close(); rmSync(root, { recursive: true, force: true }); });
  await controller.createNew();
  controller.setName("original");
  const journal = controller.currentJournal!;
  const append = t.mock.method(journal, "appendRecord", () => { throw new Error("write failed"); });
  assert.throws(() => controller.setName("not written"), /write failed/);
  assert.equal(controller.currentTitle, "original");
  append.mock.restore();
  const flush = t.mock.method(journal, "flush", () => { throw new Error("flush failed"); });
  assert.throws(() => controller.setName("uncertain durability"), /flush failed/);
  assert.equal(controller.currentTitle, "original");
  flush.mock.restore();
  assert.equal(sessionTitleAt(readSessionFile(journal.path).items), "uncertain durability");
  controller.setName("original");
  assert.equal(controller.currentTitle, "original");
  assert.equal(sessionTitleAt(readSessionFile(journal.path).items), "original");
});
