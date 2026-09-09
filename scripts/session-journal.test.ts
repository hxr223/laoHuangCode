import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  SessionCorruptError,
  SessionJournalLockError,
  SessionSchemaError,
  createSessionJournal,
  projectKeyForRoot,
  readSessionFile,
  parseSessionHeader,
  parseSessionItem,
  validateSessionItems,
  normalizeSessionTitle,
  sessionTitleAt,
  type SessionHeader,
  type SessionItem,
} from "@laohuang/session-store";

const header: SessionHeader = {
  schemaVersion: 1,
  type: "session_header",
  sessionId: "0123456789abcdef0123456789abcdef",
  createdAt: "2026-08-31T00:00:00.000Z",
  initialCwd: "/tmp/project",
  projectRoot: "/tmp/project",
  projectKey: "project-abc123",
  appVersion: "0.7.0",
  provider: "pi-ai",
  model: "gpt-test",
  reasoningEffort: "high",
  origin: "new",
};

function userEntry(seq: number): SessionItem {
  return {
    schemaVersion: 1,
    sessionId: header.sessionId,
    seq,
    id: `entry-${seq}`,
    timestamp: "2026-08-31T00:00:00.000Z",
    kind: "entry",
    entryType: "user_message",
    payload: {
      message: { role: "user", content: `message ${seq}` },
      inputEventIds: [],
      source: "direct",
    },
  };
}

test("session schema accepts valid headers and items", () => {
  assert.deepEqual(parseSessionHeader(header), header);
  assert.deepEqual(parseSessionItem(userEntry(1), header.sessionId), userEntry(1));
  assert.deepEqual(validateSessionItems([userEntry(1), userEntry(2)], header), [
    userEntry(1),
    userEntry(2),
  ]);
});

test("session schema rejects unknown versions and invalid discriminants", () => {
  assert.throws(
    () => parseSessionHeader({ ...header, schemaVersion: 2 }),
    SessionSchemaError,
  );
  assert.throws(
    () => parseSessionHeader({ ...header, type: "wrong" }),
    SessionSchemaError,
  );
  assert.throws(
    () => parseSessionItem({ ...userEntry(1), kind: "unknown" }, header.sessionId),
    SessionSchemaError,
  );
  assert.throws(
    () => parseSessionItem({ ...userEntry(1), entryType: "unknown" }, header.sessionId),
    SessionSchemaError,
  );
});

test("session schema rejects wrong session id and non-increasing seq", () => {
  assert.throws(
    () => parseSessionItem({ ...userEntry(1), sessionId: "other" }, header.sessionId),
    SessionSchemaError,
  );
  assert.throws(
    () => validateSessionItems([userEntry(1), userEntry(1)], header),
    SessionSchemaError,
  );
  assert.throws(
    () => validateSessionItems([userEntry(2), userEntry(1)], header),
    SessionSchemaError,
  );
});

test("project keys include basename and canonical root hash", () => {
  const left = projectKeyForRoot("/tmp/work/project");
  const right = projectKeyForRoot("/tmp/other/project");

  assert.match(left, /^project-[a-f0-9]{12}$/);
  assert.match(right, /^project-[a-f0-9]{12}$/);
  assert.notEqual(left, right);
});

test("journal creates private directories and files, appends seq, and closes lock", () => {
  const root = makeTempRoot();
  const journal = createSessionJournal({
    sessionsRoot: root,
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
    origin: "new",
  });

  assert.equal(statSync(join(root, journal.header.projectKey)).mode & 0o777, 0o700);
  assert.equal(statSync(journal.path).mode & 0o777, 0o600);
  const first = journal.appendEntry({
    entryType: "user_message",
    payload: {
      message: { role: "user", content: "hello" },
      inputEventIds: [],
      source: "direct",
    },
  });
  const second = journal.appendRecord({
    recordType: "turn_finished",
    payload: { ok: true },
  });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(journal.nextSeq, 3);
  assert.equal(statSync(journal.path).mode & 0o777, 0o600);
  assert.equal(statSync(`${journal.path}.lock`).mode & 0o777, 0o600);

  journal.close();
  assert.throws(() => statSync(`${journal.path}.lock`));
});

test("journal rejects concurrent writer and removes stale lock", () => {
  const root = makeTempRoot();
  const first = createSessionJournal({
    sessionsRoot: root,
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
    origin: "new",
  });

  assert.throws(
    () => createSessionJournal({ sessionsRoot: root, header: first.header, path: first.path }),
    SessionJournalLockError,
  );
  const lockPath = `${first.path}.lock`;
  first.close();
  writeFileSync(lockPath, JSON.stringify({ pid: 99999999, sessionId: first.header.sessionId }));

  const reopened = createSessionJournal({
    sessionsRoot: root,
    header: first.header,
    path: first.path,
  });
  reopened.close();
});

test("reader ignores torn tail but rejects middle corruption and seq gaps", () => {
  const root = makeTempRoot();
  const journal = createSessionJournal({
    sessionsRoot: root,
    projectRoot: "/tmp/project",
    initialCwd: "/tmp/project",
    appVersion: "0.7.0",
    provider: "pi-ai",
    model: "gpt-test",
    reasoningEffort: "high",
    origin: "new",
  });
  journal.appendEntry({
    entryType: "user_message",
    payload: {
      message: { role: "user", content: "hello" },
      inputEventIds: [],
      source: "direct",
    },
  });
  journal.close();
  writeFileSync(journal.path, `${readFileSync(journal.path, "utf8")}{"not":`, "utf8");

  const torn = readSessionFile(journal.path);
  assert.equal(torn.ignoredTornTail, true);
  assert.equal(torn.items.length, 1);
  assert.equal(torn.lastSeq, 1);

  const corruptPath = join(root, "corrupt.jsonl");
  writeFileSync(
    corruptPath,
    `${JSON.stringify(header)}\n{"bad":\n${JSON.stringify(userEntry(1))}\n`,
  );
  assert.throws(() => readSessionFile(corruptPath), SessionCorruptError);

  const gapPath = join(root, "gap.jsonl");
  writeFileSync(
    gapPath,
    `${JSON.stringify(header)}\n${JSON.stringify(userEntry(1))}\n${JSON.stringify(userEntry(3))}\n`,
  );
  assert.throws(() => readSessionFile(gapPath), SessionCorruptError);
});

function makeTempRoot(): string {
  const root = join(tmpdir(), `laohuang-session-test-${process.pid}-${Date.now()}-${Math.random()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

test("session names reject controls and replay only normalized metadata", (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(normalizeSessionTitle("  MCP 接入设计  "), "MCP 接入设计");
  for (const invalid of ["", "   ", "name\n", "\tname", "a\x1bb", "a\u0085b", "a\u2028b", "a\u2029b"]) {
    assert.throws(() => normalizeSessionTitle(invalid));
  }
  const journal = createSessionJournal({ sessionsRoot: root, header });
  const first = journal.appendRecord({
    recordType: "session_name_changed", payload: { title: "最初名称" },
  });
  const second = journal.appendRecord({
    recordType: "session_name_changed", payload: { title: "最终名称" },
  });
  journal.flush();
  journal.close();
  const replay = readSessionFile(journal.path);
  assert.equal(sessionTitleAt(replay.items), "最终名称");
  assert.equal(sessionTitleAt(replay.items, first.seq), "最初名称");
  assert.equal(sessionTitleAt(replay.items, 0), null);
  assert.equal(replay.items.every((item) => item.kind === "record"), true);
  for (const title of [null, 42, "", "   ", " padded ", "bad\nname"]) {
    assert.throws(() => parseSessionItem({ ...second, payload: { title } }), SessionSchemaError);
  }
});
