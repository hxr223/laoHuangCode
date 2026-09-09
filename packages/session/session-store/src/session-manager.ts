import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  createSessionJournal,
  type CreateSessionJournalOptions,
  type SessionJournal,
} from "./session-journal.ts";
import {
  readSessionFile,
  type SessionReplay,
} from "./session-reader.ts";
import {
  canonicalProjectRoot,
  projectKeyForRoot,
} from "./session-paths.ts";
import { buildSessionTree, type SessionTreeNode } from "./session-tree.ts";
import { sessionTitleAt } from "./session-metadata.ts";
import type {
  NewSessionEntry,
  SessionEntry,
  SessionHeader,
  SessionItem,
} from "./schema.ts";

export interface SessionManagerOptions {
  readonly sessionsRoot: string;
  readonly appVersion: string;
}

export interface CreateSessionOptions {
  readonly projectRoot: string;
  readonly initialCwd: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: SessionHeader["reasoningEffort"];
}

export interface OpenedSession {
  readonly header: SessionHeader;
  readonly journal: SessionJournal;
  readonly replay: SessionReplay;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly path: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly origin: SessionHeader["origin"];
  readonly parentSessionId?: string;
  readonly title?: string;
  readonly lastUserText: string;
  readonly status: "open" | "closed" | "interrupted" | "corrupt";
}

export interface ForkSessionOptions {
  readonly parentSessionId: string;
  readonly entryId: string;
  readonly mode: "before" | "at";
}

export interface ForkResult {
  readonly sessionId: string;
  readonly path: string;
  readonly editorText: string;
}

export interface CloneSessionOptions {
  readonly parentSessionId: string;
}

export interface CloneResult {
  readonly sessionId: string;
  readonly path: string;
}

export class SessionManager {
  readonly #sessionsRoot: string;
  readonly #appVersion: string;

  constructor(options: SessionManagerOptions) {
    this.#sessionsRoot = options.sessionsRoot;
    this.#appVersion = options.appVersion;
  }

  create(options: CreateSessionOptions): OpenedSession {
    const journal = createSessionJournal({
      sessionsRoot: this.#sessionsRoot,
      projectRoot: options.projectRoot,
      initialCwd: options.initialCwd,
      appVersion: this.#appVersion,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      origin: "new",
    });
    return {
      header: journal.header,
      journal,
      replay: {
        header: journal.header,
        items: [],
        lastSeq: 0,
        ignoredTornTail: false,
        openToolCalls: [],
      },
    };
  }

  open(sessionId: string): OpenedSession {
    const summary = this.list().find((item) => item.sessionId === sessionId);
    if (summary === undefined || summary.status === "corrupt") {
      throw new Error(`unknown session: ${sessionId}`);
    }
    const replay = readSessionFile(summary.path);
    const journal = createSessionJournal({
      sessionsRoot: this.#sessionsRoot,
      header: replay.header,
      path: summary.path,
    });
    return { header: replay.header, journal, replay };
  }

  continueLatest(projectRoot: string): OpenedSession | null {
    const latest = this.list(projectRoot).find((item) => item.status !== "corrupt");
    return latest === undefined ? null : this.open(latest.sessionId);
  }

  list(projectRoot?: string): readonly SessionSummary[] {
    const canonical = projectRoot === undefined ? null : canonicalProjectRoot(projectRoot);
    return this.sessionPaths()
      .map((path) => summaryForPath(path))
      .filter((summary) => canonical === null || summary.projectRoot === canonical)
      .sort((left, right) => {
        const updated = right.updatedAt.localeCompare(left.updatedAt);
        return updated === 0 ? right.createdAt.localeCompare(left.createdAt) : updated;
      });
  }

  tree(projectRoot?: string): readonly SessionTreeNode[] {
    return buildSessionTree(this.list(projectRoot).filter((item) => item.status !== "corrupt"));
  }

  fork(options: ForkSessionOptions): ForkResult {
    const parent = this.parentReplay(options.parentSessionId);
    const target = parent.items.find(
      (item): item is Extract<SessionEntry, { readonly entryType: "user_message" }> =>
        item.kind === "entry" &&
        item.entryType === "user_message" &&
        item.id === options.entryId,
    );
    if (target === undefined) {
      throw new Error("fork target must be a user_message entry");
    }
    const child = createSessionJournal({
      sessionsRoot: this.#sessionsRoot,
      projectRoot: parent.header.projectRoot,
      initialCwd: parent.header.initialCwd,
      appVersion: this.#appVersion,
      provider: parent.header.provider,
      model: parent.header.model,
      reasoningEffort: parent.header.reasoningEffort,
      origin: "fork",
      parentSessionId: parent.header.sessionId,
      forkedFrom: {
        sessionId: parent.header.sessionId,
        seq: target.seq,
        entryId: target.id,
        mode: options.mode,
      },
    });
    const throughSeq = options.mode === "before" ? target.seq - 1 : target.seq;
    copyEntries(child, parent.items.filter(isEntry).filter((item) => item.seq <= throughSeq));
    appendTitleSnapshot(child, sessionTitleAt(parent.items, throughSeq));
    child.close();
    return {
      sessionId: child.header.sessionId,
      path: child.path,
      editorText: options.mode === "before" ? target.payload.message.content : "",
    };
  }

  clone(options: CloneSessionOptions): CloneResult {
    const parent = this.parentReplay(options.parentSessionId);
    const lastEntry = [...parent.items].reverse().find(
      (item): item is SessionEntry => item.kind === "entry",
    );
    const child = createSessionJournal({
      sessionsRoot: this.#sessionsRoot,
      projectRoot: parent.header.projectRoot,
      initialCwd: parent.header.initialCwd,
      appVersion: this.#appVersion,
      provider: parent.header.provider,
      model: parent.header.model,
      reasoningEffort: parent.header.reasoningEffort,
      origin: "clone",
      parentSessionId: parent.header.sessionId,
      forkedFrom: {
        sessionId: parent.header.sessionId,
        ...(lastEntry === undefined ? {} : { seq: lastEntry.seq, entryId: lastEntry.id }),
        mode: "clone",
      },
    });
    copyEntries(child, parent.items.filter(isEntry));
    appendTitleSnapshot(child, sessionTitleAt(parent.items));
    child.close();
    return { sessionId: child.header.sessionId, path: child.path };
  }

  private parentReplay(sessionId: string): SessionReplay {
    const summary = this.list().find((item) => item.sessionId === sessionId);
    if (summary === undefined || summary.status === "corrupt") {
      throw new Error(`unknown session: ${sessionId}`);
    }
    return readSessionFile(summary.path);
  }

  private sessionPaths(): readonly string[] {
    if (!existsSync(this.#sessionsRoot)) {
      return [];
    }
    const paths: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const absolute = join(directory, entry);
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
          visit(absolute);
        } else if (absolute.endsWith(".jsonl")) {
          paths.push(absolute);
        }
      }
    };
    visit(this.#sessionsRoot);
    return paths.sort();
  }
}

function summaryForPath(path: string): SessionSummary {
  try {
    const replay = readSessionFile(path);
    const last = replay.items.at(-1);
    const title = sessionTitleAt(replay.items);
    return {
      sessionId: replay.header.sessionId,
      path,
      createdAt: replay.header.createdAt,
      updatedAt: last?.timestamp ?? replay.header.createdAt,
      projectRoot: replay.header.projectRoot,
      cwd: cwdFrom(replay),
      provider: replay.header.provider,
      model: replay.header.model,
      origin: replay.header.origin,
      ...(replay.header.parentSessionId === undefined ? {} : { parentSessionId: replay.header.parentSessionId }),
      ...(title === null ? {} : { title }),
      lastUserText: lastUserText(replay.items),
      status: last?.kind === "record" && last.recordType === "session_closed"
        ? "closed"
        : existsSync(`${path}.lock`)
          ? "open"
          : "interrupted",
    };
  } catch {
    return {
      sessionId: path,
      path,
      createdAt: "",
      updatedAt: "",
      projectRoot: "",
      cwd: "",
      provider: "",
      model: "",
      origin: "import",
      lastUserText: "",
      status: "corrupt",
    };
  }
}

function cwdFrom(replay: SessionReplay): string {
  for (const item of [...replay.items].reverse()) {
    if (item.kind === "entry" && item.entryType === "system_context") {
      return item.payload.cwd;
    }
  }
  return replay.header.initialCwd;
}

function lastUserText(items: readonly SessionItem[]): string {
  for (const item of [...items].reverse()) {
    if (item.kind === "entry" && item.entryType === "user_message") {
      return item.payload.message.content;
    }
  }
  return "";
}

function copyEntries(journal: SessionJournal, entries: readonly SessionEntry[]): void {
  for (const entry of entries) {
    const input: NewSessionEntry = {
      entryType: entry.entryType,
      payload: entry.payload,
      ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
      ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
      copiedFrom: {
        sessionId: entry.sessionId,
        itemId: entry.id,
        seq: entry.seq,
      },
    } as NewSessionEntry;
    journal.appendEntry(input);
  }
}

function isEntry(item: SessionItem): item is SessionEntry {
  return item.kind === "entry";
}

function appendTitleSnapshot(journal: SessionJournal, title: string | null): void {
  if (title !== null) {
    journal.appendRecord({
      recordType: "session_name_changed",
      payload: { title },
    });
  }
}
