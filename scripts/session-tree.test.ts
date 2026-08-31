import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionManager } from "@laohuang/session-store";

test("session tree groups children under parent sessions", () => {
  const root = makeTempRoot();
  const manager = new SessionManager({ sessionsRoot: root, appVersion: "0.7.0" });
  const parent = manager.create({
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
  });
  const user = parent.journal.appendEntry({
    entryType: "user_message",
    payload: {
      message: { role: "user", content: "branch from here" },
      inputEventIds: [],
      source: "direct",
    },
  });
  parent.journal.close();
  const forked = manager.fork({
    parentSessionId: parent.header.sessionId,
    entryId: user.id,
    mode: "at",
  });
  const cloned = manager.clone({ parentSessionId: parent.header.sessionId });

  const tree = manager.tree("/tmp/project");
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.session.sessionId, parent.header.sessionId);
  assert.deepEqual(
    tree[0]!.children.map((child) => child.session.sessionId).sort(),
    [forked.sessionId, cloned.sessionId].sort(),
  );
});

function makeTempRoot(): string {
  const root = join(tmpdir(), `laohuang-session-tree-${process.pid}-${Date.now()}-${Math.random()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}
