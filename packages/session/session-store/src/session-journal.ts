import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import {
  canonicalProjectRoot,
  projectKeyForRoot,
  sessionPathForHeader,
} from "./session-paths.ts";
import { readSessionFile } from "./session-reader.ts";
import type {
  NewSessionEntry,
  NewSessionRecord,
  SessionEntry,
  SessionHeader,
  SessionItemBase,
  SessionRecord,
} from "./schema.ts";

export interface SessionJournal {
  readonly header: SessionHeader;
  readonly path: string;
  readonly nextSeq: number;
  appendEntry(input: NewSessionEntry): SessionEntry;
  appendRecord(input: NewSessionRecord): SessionRecord;
  flush(): void;
  close(): void;
}

export interface CreateSessionJournalOptions {
  readonly sessionsRoot: string;
  readonly projectRoot?: string;
  readonly initialCwd?: string;
  readonly appVersion?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: SessionHeader["reasoningEffort"];
  readonly origin?: SessionHeader["origin"];
  readonly parentSessionId?: string;
  readonly forkedFrom?: SessionHeader["forkedFrom"];
  readonly header?: SessionHeader;
  readonly path?: string;
}

export class SessionJournalLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionJournalLockError";
  }
}

class FileSessionJournal implements SessionJournal {
  readonly header: SessionHeader;
  readonly path: string;
  #fd: number;
  #lockPath: string;
  #nextSeq: number;
  #closed = false;

  constructor(input: { header: SessionHeader; path: string; nextSeq: number; fd: number }) {
    this.header = input.header;
    this.path = input.path;
    this.#nextSeq = input.nextSeq;
    this.#fd = input.fd;
    this.#lockPath = `${input.path}.lock`;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  appendEntry(input: NewSessionEntry): SessionEntry {
    const item = this.makeBase(input) as SessionItemBase;
    const entry = {
      ...item,
      kind: "entry",
      entryType: input.entryType,
      payload: input.payload,
    } as SessionEntry;
    this.writeItem(entry);
    if (entry.entryType === "compaction") {
      this.flush();
    }
    return entry;
  }

  appendRecord(input: NewSessionRecord): SessionRecord {
    const record: SessionRecord = {
      ...this.makeBase(input),
      kind: "record",
      recordType: input.recordType,
      payload: input.payload ?? {},
    };
    this.writeItem(record);
    if (
      record.recordType === "turn_finished" ||
      record.recordType === "compaction_finished" ||
      record.recordType === "session_closed"
    ) {
      this.flush();
    }
    return record;
  }

  flush(): void {
    if (!this.#closed) {
      fsyncSync(this.#fd);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.flush();
    closeSync(this.#fd);
    this.#closed = true;
    if (existsSync(this.#lockPath)) {
      unlinkSync(this.#lockPath);
    }
  }

  private makeBase(
    input: Pick<NewSessionEntry | NewSessionRecord, "taskId" | "turnId"> & {
      readonly copiedFrom?: SessionItemBase["copiedFrom"];
    },
  ): Omit<SessionItemBase, "kind"> {
    return {
      schemaVersion: 1,
      sessionId: this.header.sessionId,
      seq: this.#nextSeq,
      id: randomUUID().replaceAll("-", ""),
      timestamp: new Date().toISOString(),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.copiedFrom === undefined ? {} : { copiedFrom: input.copiedFrom }),
    };
  }

  private writeItem(item: SessionEntry | SessionRecord): void {
    if (this.#closed) {
      throw new Error("session journal is closed");
    }
    writeLine(this.#fd, item);
    this.#nextSeq += 1;
  }
}

export function createSessionJournal(options: CreateSessionJournalOptions): SessionJournal {
  const header = options.header ?? makeHeader(options);
  const path = options.path ??
    sessionPathForHeader(options.sessionsRoot, header.projectKey, header.createdAt, header.sessionId);
  const existing = existsSync(path);
  const lockPath = `${path}.lock`;
  acquireLock(lockPath, header.sessionId);
  try {
    const fd = openSync(path, existing ? "a" : "wx", 0o600);
    if (!existing) {
      writeLine(fd, header);
      fsyncSync(fd);
      return new FileSessionJournal({ header, path, nextSeq: 1, fd });
    }
    const replay = readSessionFile(path);
    return new FileSessionJournal({
      header: replay.header,
      path,
      nextSeq: replay.lastSeq + 1,
      fd,
    });
  } catch (error) {
    releaseLock(lockPath);
    throw error;
  }
}

function makeHeader(options: CreateSessionJournalOptions): SessionHeader {
  const projectRoot = canonicalProjectRoot(required(options.projectRoot, "projectRoot"));
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    type: "session_header",
    sessionId: randomUUID().replaceAll("-", ""),
    createdAt,
    initialCwd: required(options.initialCwd, "initialCwd"),
    projectRoot,
    projectKey: projectKeyForRoot(projectRoot),
    appVersion: required(options.appVersion, "appVersion"),
    provider: required(options.provider, "provider"),
    model: required(options.model, "model"),
    reasoningEffort: options.reasoningEffort ?? "high",
    origin: options.origin ?? "new",
    ...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
    ...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
  };
}

function acquireLock(path: string, sessionId: string): void {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeLine(fd, { pid: process.pid, sessionId, startedAt: new Date().toISOString() });
    closeSync(fd);
  } catch (error) {
    if (!isLiveLock(path)) {
      releaseLock(path);
      const fd = openSync(path, "wx", 0o600);
      writeLine(fd, { pid: process.pid, sessionId, startedAt: new Date().toISOString() });
      closeSync(fd);
      return;
    }
    throw new SessionJournalLockError(`session journal is locked: ${path}`);
  }
}

function isLiveLock(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
      return false;
    }
    process.kill(parsed.pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "EPERM";
  }
}

function releaseLock(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

function writeLine(fd: number, value: unknown): void {
  writeSync(fd, `${JSON.stringify(value)}\n`);
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${label} is required`);
  }
  return value;
}
