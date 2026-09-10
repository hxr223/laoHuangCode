import { EventBus } from "@laohuang/runtime-protocol";
import {
  ConversationHistory,
  type CompactionResult,
} from "@laohuang/session-context";
import {
  SessionManager,
  canonicalProjectRoot,
  normalizeSessionTitle,
  sessionTitleAt,
  type ForkResult,
  type OpenedSession,
  type SessionSummary,
  type SessionJournal,
} from "@laohuang/session-store";
import type { ReasoningEffort } from "@laohuang/llm";

export interface SessionControllerOptions {
  readonly sessionsRoot: string;
  readonly projectRoot: string;
  readonly initialCwd: string;
  readonly appVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
}

export type SessionCompactor = () => Promise<CompactionResult>;

export class SessionController {
  readonly #manager: SessionManager;
  readonly #projectRoot: string;
  readonly #initialCwd: string;
  readonly #provider: string;
  readonly #model: string;
  readonly #reasoningEffort: ReasoningEffort;
  readonly #sessionsRoot: string;
  #compactor: SessionCompactor | null = null;
  #opened: OpenedSession | null = null;
  #history: ConversationHistory | null = null;
  #currentTitle: string | null = null;
  #titlePersistenceUncertain = false;
  readonly presentationEventBus = new EventBus();

  constructor(options: SessionControllerOptions) {
    this.#sessionsRoot = options.sessionsRoot;
    this.#manager = new SessionManager({
      sessionsRoot: options.sessionsRoot,
      appVersion: options.appVersion,
    });
    this.#projectRoot = canonicalProjectRoot(options.projectRoot);
    this.#initialCwd = options.initialCwd;
    this.#provider = options.provider;
    this.#model = options.model;
    this.#reasoningEffort = options.reasoningEffort;
  }

  get sessionsRoot(): string {
    return this.#sessionsRoot;
  }

  get currentSessionId(): string | null {
    return this.#opened?.header.sessionId ?? null;
  }

  get currentPath(): string | null {
    return this.#opened?.journal.path ?? null;
  }

  get history(): ConversationHistory | null {
    return this.#history;
  }

  get currentJournal(): SessionJournal | null {
    return this.#opened?.journal ?? null;
  }

  get currentTitle(): string | null {
    return this.#currentTitle;
  }

  latestAssistantText(): string | null {
    const entries = this.#history?.entries() ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.entryType !== "assistant_message") continue;
      const text = entry.payload.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text.length > 0) return text;
    }
    return null;
  }

  async createNew(): Promise<void> {
    await this.close();
    this.#opened = this.#manager.create({
      projectRoot: this.#projectRoot,
      initialCwd: this.#initialCwd,
      provider: this.#provider,
      model: this.#model,
      reasoningEffort: this.#reasoningEffort,
    });
    this.#history = ConversationHistory.fromReplay(
      this.#opened.replay,
      this.#opened.journal,
    );
    this.#currentTitle = null;
    this.#titlePersistenceUncertain = false;
  }

  async resume(sessionId: string): Promise<void> {
    await this.close();
    const opened = this.#manager.open(sessionId);
    if (opened.header.projectRoot !== this.#projectRoot) {
      opened.journal.close();
      throw new Error("project root mismatch for resumed session");
    }
    this.#opened = opened;
    this.#history = ConversationHistory.fromReplay(opened.replay, opened.journal);
    this.#currentTitle = sessionTitleAt(opened.replay.items);
    this.#titlePersistenceUncertain = false;
  }

  async continueLatest(): Promise<void> {
    await this.close();
    const opened = this.#manager.continueLatest(this.#projectRoot);
    if (opened === null) {
      await this.createNew();
      return;
    }
    this.#opened = opened;
    this.#history = ConversationHistory.fromReplay(opened.replay, opened.journal);
    this.#currentTitle = sessionTitleAt(opened.replay.items);
    this.#titlePersistenceUncertain = false;
  }

  list(): readonly SessionSummary[] {
    return this.#manager.list(this.#projectRoot);
  }

  async fork(entryId: string, mode: "before" | "at"): Promise<ForkResult> {
    if (this.currentSessionId === null) {
      throw new Error("no active session");
    }
    const result = this.#manager.fork({
      parentSessionId: this.currentSessionId,
      entryId,
      mode,
    });
    await this.resume(result.sessionId);
    return result;
  }

  async clone(): Promise<{ readonly sessionId: string; readonly path: string }> {
    if (this.currentSessionId === null) {
      throw new Error("no active session");
    }
    const result = this.#manager.clone({ parentSessionId: this.currentSessionId });
    await this.resume(result.sessionId);
    return result;
  }

  setCompactor(compactor: SessionCompactor | null): void {
    this.#compactor = compactor;
  }

  setName(input: string): void {
    const title = normalizeSessionTitle(input);
    const journal = this.currentJournal;
    if (journal === null) {
      throw new Error("No active session.");
    }
    if (!this.#titlePersistenceUncertain && title === this.#currentTitle) {
      return;
    }
    journal.appendRecord({
      recordType: "session_name_changed",
      payload: { title },
    });
    try {
      journal.flush();
    } catch (error) {
      this.#titlePersistenceUncertain = true;
      throw error;
    }
    this.#currentTitle = title;
    this.#titlePersistenceUncertain = false;
  }

  async compact(): Promise<CompactionResult> {
    if (this.#history === null) {
      throw new Error("no active session");
    }
    if (this.#compactor === null) {
      throw new Error("manual compaction requires runtime wiring");
    }
    return this.#compactor();
  }

  async close(): Promise<boolean> {
    if (this.#opened === null) {
      return true;
    }
    this.#opened.journal.appendRecord({
      recordType: "session_closed",
      payload: { reason: "normal" },
    });
    this.#opened.journal.close();
    this.#opened = null;
    this.#history = null;
    this.#currentTitle = null;
    this.#titlePersistenceUncertain = false;
    return true;
  }
}
