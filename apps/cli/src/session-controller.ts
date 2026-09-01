import { EventBus } from "@laohuang/runtime-protocol";
import {
  ConversationHistory,
  type CompactionResult,
} from "@laohuang/session-context";
import {
  SessionManager,
  canonicalProjectRoot,
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
    return true;
  }
}
