import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CliUsageError, parseArgs } from "../apps/cli/src/args.ts";
import { SessionController } from "../apps/cli/src/session-controller.ts";

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

test("session controller wires context reset and manual compaction to active history", async () => {
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

  controller.resetContext();

  assert.equal(controller.history?.entries().at(-1)?.entryType, "context_reset");

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
