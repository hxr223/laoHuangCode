/** Slash commands available inside an interactive agent session. */

import { EventKind, EventSource } from "@laohuang/runtime-protocol";
import { makeCancelAction } from "@laohuang/runtime-protocol";
import type { SessionAction } from "@laohuang/runtime-protocol";
import type { CommandResult, QueueStatus } from "@laohuang/runtime-protocol";
import type {
  ModelSelection,
  ModelSelector,
  SelectionConfig,
} from "./model-selection.ts";
import type { CommandPresenter } from "./command-presentation.ts";
import type {
  ModelCatalog,
  ModelProviderInfo,
  ModelAuthStatus,
  ReasoningEffort,
} from "@laohuang/llm";
import {
  clampReasoningEffort,
  isReasoningEffort,
} from "@laohuang/llm";
import type {
  AuthPromptHandler,
  ProviderAuthController,
} from "./provider-auth.ts";

export type { CommandResult, QueueStatus } from "@laohuang/runtime-protocol";

export interface CompletionItem {
  readonly value: string;
  readonly description: string;
  readonly start: number;
}

export type CommandHandler = (args: string[]) => boolean | Promise<boolean>;

export type ArgumentCompleter = (
  args: readonly string[],
) => Iterable<readonly [string, string]>;

/** One source of truth for command help, completion, and dispatch. */
export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly handler?: CommandHandler | undefined;
  readonly allowedStates?: ReadonlySet<string> | undefined;
  readonly argumentCompleter?: ArgumentCompleter | undefined;
}

/**
 * Split a command line the way POSIX `shlex.split` does: whitespace separated,
 * single/double quotes, backslash escapes. Throws on unterminated quotes.
 */
function splitCommandArgs(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (
        char === "\\" &&
        index + 1 < text.length &&
        ['"', "\\", "$", "`"].includes(text[index + 1]!)
      ) {
        index += 1;
        current += text[index]!;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\\") {
      if (index + 1 < text.length) {
        index += 1;
        current += text[index]!;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
    }
  }
  if (quote !== null) {
    throw new Error("No closing quotation");
  }
  if (started || current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

// --- difflib.get_close_matches equivalent -----------------------------------
// difflib's SequenceMatcher ratio for short inputs (the autojunk heuristic
// only kicks in above 200 characters): 2 * M / T where M counts the recursive
// longest contiguous matching blocks.

function longestMatchSize(
  a: string,
  aStart: number,
  aEnd: number,
  b: string,
  bStart: number,
  bEnd: number,
): { size: number; aIndex: number; bIndex: number } {
  let best = { size: 0, aIndex: aStart, bIndex: bStart };
  for (let i = aStart; i < aEnd; i += 1) {
    for (let j = bStart; j < bEnd; j += 1) {
      let size = 0;
      while (
        i + size < aEnd &&
        j + size < bEnd &&
        a[i + size] === b[j + size]
      ) {
        size += 1;
      }
      if (size > best.size) {
        best = { size, aIndex: i, bIndex: j };
      }
    }
  }
  return best;
}

function matchingBlockCount(
  a: string,
  aStart: number,
  aEnd: number,
  b: string,
  bStart: number,
  bEnd: number,
): number {
  const match = longestMatchSize(a, aStart, aEnd, b, bStart, bEnd);
  if (match.size === 0) {
    return 0;
  }
  return (
    match.size +
    matchingBlockCount(a, aStart, match.aIndex, b, bStart, match.bIndex) +
    matchingBlockCount(
      a,
      match.aIndex + match.size,
      aEnd,
      b,
      match.bIndex + match.size,
      bEnd,
    )
  );
}

function sequenceRatio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) {
    return 1;
  }
  return (2 * matchingBlockCount(a, 0, a.length, b, 0, b.length)) / total;
}

/** Store slash commands without coupling prompt rendering to handlers. */
export class CommandRegistry {
  readonly #specs = new Map<string, CommandSpec>();

  constructor(specs: Iterable<CommandSpec> = []) {
    for (const spec of specs) {
      this.register(spec);
    }
  }

  register(spec: CommandSpec): void {
    if (!spec.name.startsWith("/")) {
      throw new Error("Command names must start with '/'");
    }
    this.#specs.set(spec.name, spec);
  }

  get(name: string): CommandSpec | undefined {
    return this.#specs.get(name);
  }

  all(): CommandSpec[] {
    return [...this.#specs.keys()].sort().map((name) => this.#specs.get(name)!);
  }

  suggest(name: string): string | null {
    let best: string | null = null;
    let bestScore = 0;
    for (const candidate of this.#specs.keys()) {
      const score = sequenceRatio(name, candidate);
      // Strict ">" keeps the earliest registration on ties, mirroring the
      // stable ordering of difflib.get_close_matches(n=1).
      if (score >= 0.55 && score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  /** Return slash-command and argument candidates for the given state. */
  complete(text: string, options: { state: string }): CompletionItem[] {
    const { state } = options;
    if (!text.startsWith("/") || text.includes("\n")) {
      return [];
    }

    if (!text.includes(" ")) {
      return this.all()
        .filter(
          (spec) =>
            spec.name.startsWith(text) &&
            CommandRegistry.available(spec, state),
        )
        .map((spec) => ({
          value: spec.name,
          description: spec.description,
          start: -text.length,
        }));
    }

    const splitAt = text.indexOf(" ");
    const commandName = text.slice(0, splitAt);
    const rawArguments = text.slice(splitAt + 1);
    const spec = this.get(commandName);
    if (spec === undefined || spec.argumentCompleter === undefined) {
      return [];
    }
    const completed = rawArguments.split(/\s+/).filter((part) => part !== "");
    const endsWithSpace = rawArguments.endsWith(" ");
    const fragment = endsWithSpace
      ? ""
      : (completed[completed.length - 1] ?? "");
    const fixed = endsWithSpace ? completed : completed.slice(0, -1);
    const items: CompletionItem[] = [];
    for (const [value, description] of spec.argumentCompleter(fixed)) {
      if (
        value.startsWith(fragment) &&
        CommandRegistry.argumentAvailable(spec, value, state)
      ) {
        items.push({ value, description, start: -fragment.length });
      }
    }
    return items;
  }

  private static available(spec: CommandSpec, state: string): boolean {
    return !(
      spec.allowedStates !== undefined &&
      spec.allowedStates.size > 0 &&
      !spec.allowedStates.has(state) &&
      spec.name !== "/model"
    );
  }

  private static argumentAvailable(
    spec: CommandSpec,
    value: string,
    state: string,
  ): boolean {
    return !(
      spec.allowedStates !== undefined &&
      spec.allowedStates.size > 0 &&
      !spec.allowedStates.has(state) &&
      !(spec.name === "/model" && value === "current")
    );
  }

  async execute(command: string, options: { state?: string } = {}): Promise<CommandResult> {
    let parts: string[];
    try {
      parts = splitCommandArgs(command);
    } catch (error) {
      return { status: "error", error };
    }
    const first = parts[0];
    if (first === undefined) {
      return { status: "not_found", command: "" };
    }
    const spec = this.get(first);
    if (spec === undefined) {
      return { status: "not_found", command: first };
    }
    if (spec.name === "/exit") {
      if (parts.length > 1) {
        return { status: "error", error: new Error("Usage: /exit") };
      }
      return { status: "exit_requested" };
    }
    if (
      spec.allowedStates !== undefined &&
      spec.allowedStates.size > 0 &&
      (options.state === undefined || !spec.allowedStates.has(options.state)) &&
      !(spec.name === "/model" && parts.length === 2 && parts[1] === "current")
    ) {
      return { status: "blocked", command: spec.name };
    }
    if (spec.handler === undefined) {
      return { status: "not_found", command: first };
    }
    try {
      return (await spec.handler(parts.slice(1)))
        ? { status: "handled" }
        : { status: "not_found", command: first };
    } catch (error) {
      return { status: "error", error };
    }
  }
}

/**
 * Widget adapter mirroring the old prompt_toolkit CommandCompleter: turns the
 * registry's widget-independent completion into a `text => items` function the
 * terminal input layer can consume.
 */
export function createCommandCompleter(
  registry: CommandRegistry,
  stateFn: () => string = () => "IDLE",
): (text: string) => CompletionItem[] {
  return (text) => registry.complete(text, { state: stateFn() });
}

function* queueCompletions(
  args: readonly string[],
): Iterable<readonly [string, string]> {
  if (args.length === 0) {
    yield ["resume", "恢复保留的消息"] as const;
    yield ["clear", "清空待处理和保留消息"] as const;
  }
}

// --- Structural views of modules owned by other workstreams ------------------

/** Minimal view of CodingAgent (agent.ts) that session commands rely on. */
export interface AgentLike {
  switchModel(options: {
    model: string;
    provider: string;
    baseUrl: string | null;
  }): void;
  setReasoningEffort?(effort: ReasoningEffort): void;
  getReasoningEffort?(): ReasoningEffort;
  clearHistory?(): void;
  /** Conversation history, trimmed in place when no clearHistory exists. */
  messages?: unknown[] | undefined;
}

/** Minimal view of the session's active task for state inspection. */
export interface ActiveTaskLike {
  readonly state?: unknown;
}

/** Minimal view of the session's event bus used for model.switched. */
export interface SessionEventBusLike {
  publish(
    kind: typeof EventKind.ModelSwitched,
    options: {
      source: typeof EventSource.Session;
      session_id: string;
      payload: Record<string, unknown>;
    },
  ): unknown;
}

/** Minimal view of AgentSession (session.ts) that session commands rely on. */
export interface SessionLike {
  readonly activeTask?: ActiveTaskLike | null | undefined;
  readonly eventBus?: SessionEventBusLike | null | undefined;
  readonly sessionId?: string | null | undefined;
  cancelActiveTask(): boolean;
  submitAction(action: SessionAction): unknown | Promise<unknown>;
  clearQueues(): number;
  resumeHeld(): number;
  queueStatus(): QueueStatus;
}

export interface SessionControllerLike {
  readonly currentSessionId: string | null;
  readonly currentPath: string | null;
  list(): ReadonlyArray<{
    readonly sessionId: string;
    readonly updatedAt: string;
    readonly title?: string;
    readonly lastUserText?: string;
    readonly cwd?: string;
    readonly projectRoot?: string;
  }>;
  createNew(): Promise<void>;
  resume(sessionId: string): Promise<void>;
  fork(entryId: string, mode: "before" | "at"): Promise<{
    readonly sessionId: string;
    readonly path: string;
    readonly editorText: string;
  }>;
  clone(): Promise<{ readonly sessionId: string; readonly path: string }>;
  compact(): Promise<unknown>;
}

export interface SessionCommandsOptions {
  readonly agent: AgentLike;
  readonly selector: ModelSelector;
  readonly catalog: ModelCatalog;
  readonly providerAuth: Pick<
    ProviderAuthController,
    "status" | "login" | "logout" | "ensureConfigured"
  >;
  readonly currentConfig: SelectionConfig;
  readonly presenter: CommandPresenter;
  readonly session?: SessionLike | null | undefined;
  readonly sessionController?: SessionControllerLike | null | undefined;
  readonly onModelSelected?: ((selection: ModelSelection) => void) | undefined;
  readonly onComposerText?: ((text: string) => void) | undefined;
  readonly onSessionChanged?: (() => void | Promise<void>) | undefined;
  readonly homeDirectory?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

const ALL_STATES: ReadonlySet<string> = new Set([
  "IDLE",
  "RUNNING_MODEL",
  "RUNNING_TOOLS",
  "CANCELLING",
  "FAILED",
]);
const IDLE_ONLY: ReadonlySet<string> = new Set(["IDLE", "FAILED"]);

const tones = {
  blocked: "warning",
  cancelled: "warning",
  cleared: "success",
  switched: "success",
  invalid: "error",
  unknown: "info",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SessionDisplaySummary {
  readonly updatedAt: string;
  readonly title?: string;
  readonly lastUserText?: string;
  readonly cwd?: string;
  readonly projectRoot?: string;
}

function sessionDisplayTitle(session: SessionDisplaySummary): string {
  const title = cleanSingleLine(session.title);
  if (title !== "") {
    return title;
  }
  const lastUserText = cleanSingleLine(session.lastUserText);
  return lastUserText === "" ? "Untitled session" : lastUserText;
}

function sessionDisplayDescription(
  session: SessionDisplaySummary,
  options: { readonly homeDirectory: string | null; readonly now: Date },
): string {
  const displayPath = displayPathFor(session.cwd ?? session.projectRoot ?? "", options.homeDirectory);
  const updated = relativeTimeLabel(session.updatedAt, options.now);
  return displayPath === "" ? updated : `${updated}  ${displayPath}`;
}

function cleanSingleLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function displayPathFor(path: string, homeDirectory: string | null): string {
  if (path === "" || homeDirectory === null || homeDirectory === "") {
    return path;
  }
  const home = homeDirectory.endsWith("/") ? homeDirectory.slice(0, -1) : homeDirectory;
  if (path === home) {
    return "~";
  }
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function relativeTimeLabel(updatedAt: string, now: Date): string {
  const updated = new Date(updatedAt);
  const timestamp = updated.getTime();
  if (!Number.isFinite(timestamp)) {
    return updatedAt;
  }
  const elapsedMs = Math.max(0, now.getTime() - timestamp);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds < 60) {
    return "just now";
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} ${elapsedMinutes === 1 ? "minute" : "minutes"} ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays === 1) {
    return `yesterday ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;
  }
  if (elapsedDays < 365) {
    return `${twoDigits(updated.getMonth() + 1)}-${twoDigits(updated.getDate())} ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;
  }
  return `${updated.getFullYear()}-${twoDigits(updated.getMonth() + 1)}-${twoDigits(updated.getDate())} ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;
}

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Handle session-local model and credential commands. */
export class SessionCommands {
  readonly registry: CommandRegistry;

  readonly #agent: AgentLike;
  readonly #selector: ModelSelector;
  readonly #catalog: ModelCatalog;
  readonly #providerAuth: Pick<
    ProviderAuthController,
    "status" | "login" | "logout" | "ensureConfigured"
  >;
  readonly #presenter: CommandPresenter;
  readonly #session: SessionLike | null;
  readonly #sessionController: SessionControllerLike | null;
  readonly #onModelSelected: ((selection: ModelSelection) => void) | null;
  readonly #onComposerText: ((text: string) => void) | null;
  readonly #onSessionChanged: (() => void | Promise<void>) | null;
  readonly #homeDirectory: string | null;
  readonly #now: () => Date;
  #currentConfig: SelectionConfig;

  constructor(options: SessionCommandsOptions) {
    this.#agent = options.agent;
    this.#selector = options.selector;
    this.#catalog = options.catalog;
    this.#providerAuth = options.providerAuth;
    this.#currentConfig = options.currentConfig;
    this.#presenter = options.presenter;
    this.#session = options.session ?? null;
    this.#sessionController = options.sessionController ?? null;
    this.#onModelSelected = options.onModelSelected ?? null;
    this.#onComposerText = options.onComposerText ?? null;
    this.#onSessionChanged = options.onSessionChanged ?? null;
    this.#homeDirectory = options.homeDirectory ?? null;
    this.#now = options.now ?? (() => new Date());
    this.registry = new CommandRegistry([
      {
        name: "/model",
        description: "选择当前供应商的模型或切换供应商",
        usage: "/model [provider|model] [model]",
        handler: (args) => this.handleModel(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: (args) => this.modelCompletions(args),
      },
      {
        name: "/effort",
        description: "切换模型思考等级",
        usage: "/effort [current|off|minimal|low|medium|high|xhigh|max]",
        handler: (args) => this.handleEffort(args),
        allowedStates: ALL_STATES,
        argumentCompleter: (args) => this.effortCompletions(args),
      },
      {
        name: "/login",
        description: "输入或更新API Key",
        usage: "/login [provider]",
        handler: (args) => this.handleLogin(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: (args) => this.providerCompletions(args),
      },
      {
        name: "/logout",
        description: "删除保存的API Key",
        usage: "/logout [provider]",
        handler: (args) => this.handleLogout(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: (args) => this.providerCompletions(args),
      },
      {
        name: "/providers",
        description: "查看模型供应商状态",
        usage: "/providers [provider]",
        handler: (args) => this.handleProviders(args),
        allowedStates: ALL_STATES,
        argumentCompleter: (args) => this.providerCompletions(args),
      },
      {
        name: "/apikey",
        description: "管理API Key（兼容命令）",
        usage: "/apikey [set|remove] [provider]",
        handler: (args) => this.handleApiKey(args),
        allowedStates: IDLE_ONLY,
      },
      {
        name: "/cancel",
        description: "取消当前任务",
        usage: "/cancel",
        handler: (args) => this.handleCancel(args),
        allowedStates: ALL_STATES,
      },
      {
        name: "/queue",
        description: "查看或管理待处理消息",
        usage: "/queue [resume|clear]",
        handler: (args) => this.handleQueue(args),
        allowedStates: ALL_STATES,
        argumentCompleter: queueCompletions,
      },
      {
        name: "/new",
        description: "创建新会话",
        usage: "/new",
        handler: (args) => this.handleNew(args),
        allowedStates: IDLE_ONLY,
      },
      {
        name: "/session",
        description: "查看当前会话",
        usage: "/session",
        handler: (args) => this.handleSession(args),
        allowedStates: ALL_STATES,
      },
      {
        name: "/sessions",
        description: "列出当前项目会话",
        usage: "/sessions",
        handler: (args) => this.handleSessions(args),
        allowedStates: ALL_STATES,
      },
      {
        name: "/resume",
        description: "选择或恢复指定会话",
        usage: "/resume [session-id]",
        handler: (args) => this.handleResume(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: (args) => this.resumeCompletions(args),
      },
      {
        name: "/fork",
        description: "从用户消息分叉会话",
        usage: "/fork <entry-id> [before|at]",
        handler: (args) => this.handleFork(args),
        allowedStates: IDLE_ONLY,
      },
      {
        name: "/clone",
        description: "克隆当前会话",
        usage: "/clone",
        handler: (args) => this.handleClone(args),
        allowedStates: IDLE_ONLY,
      },
      {
        name: "/compact",
        description: "手动压缩当前上下文",
        usage: "/compact",
        handler: (args) => this.handleCompact(args),
        allowedStates: IDLE_ONLY,
      },
      {
        name: "/help",
        description: "查看命令帮助",
        usage: "/help",
        handler: (args) => this.handleHelp(args),
        allowedStates: ALL_STATES,
      },
      {
        name: "/exit",
        description: "退出程序",
        usage: "/exit",
        allowedStates: ALL_STATES,
      },
    ]);
    this.adjustReasoningEffortForCurrentModel({ emitNotice: false });
  }

  get currentConfig(): SelectionConfig {
    return this.#currentConfig;
  }

  get presenter(): CommandPresenter {
    return this.#presenter;
  }

  async execute(command: string): Promise<CommandResult> {
    const result = await this.registry.execute(command, {
      state: this.runtimeState(),
    });
    if (result.status === "blocked") {
      this.notice(
        `${result.command} is unavailable while the task is ${this.runtimeState().toLowerCase()}.`,
        tones.blocked,
      );
    }
    return result;
  }

  private runtimeState(): string {
    const session = this.#session;
    if (session === null) {
      return "IDLE";
    }
    const active = session.activeTask ?? null;
    if (active === null) {
      return "IDLE";
    }
    const rawState: unknown = active.state ?? "IDLE";
    const named =
      typeof rawState === "object" &&
      rawState !== null &&
      "name" in rawState
        ? (rawState as { name: unknown }).name
        : rawState;
    return String(named).toUpperCase();
  }

  private handleHelp(args: string[]): boolean {
    if (args.length > 0) {
      this.notice("Usage: /help", tones.invalid);
      return true;
    }
    this.#presenter.help({
      commands: this.registry.all().map((spec) => ({
        name: spec.name,
        usage: spec.usage,
        description: spec.description,
      })),
    });
    return true;
  }

  private async handleCancel(args: string[]): Promise<boolean> {
    if (args.length > 0) {
      this.notice("Usage: /cancel", tones.invalid);
      return true;
    }
    if (this.#session === null) {
      this.notice("No active task to cancel.", tones.cancelled);
      return true;
    }
    const cancelled = await this.#session.submitAction(
      makeCancelAction("command", "command"),
    );
    this.notice(
      cancelled === true
        ? "Cancelling current task…"
        : "No active task to cancel.",
      tones.cancelled,
    );
    return true;
  }

  private handleQueue(args: string[]): boolean {
    if (
      args.length > 1 ||
      (args.length > 0 && args[0] !== "resume" && args[0] !== "clear")
    ) {
      this.notice("Usage: /queue [resume|clear]", tones.invalid);
      return true;
    }
    if (this.#session === null) {
      this.#presenter.queue({
        queue: {
          pending: 0,
          pendingTokens: 0,
          held: 0,
          heldTokens: 0,
          deadLetters: 0,
        },
      });
      return true;
    }
    if (args[0] === "clear") {
      const cleared = this.#session.clearQueues();
      this.notice(`Cleared ${cleared} queued message(s).`, tones.cleared);
      return true;
    }
    if (args[0] === "resume") {
      const resumed = this.#session.resumeHeld();
      this.notice(`Resumed ${resumed} held message(s).`, tones.switched);
      return true;
    }
    const status = this.#session.queueStatus();
    this.#presenter.queue({
      queue: {
        pending: status.pending ?? 0,
        pendingTokens: status.pendingTokens ?? 0,
        held: status.held ?? 0,
        heldTokens: status.heldTokens ?? 0,
        deadLetters: status.deadLetters ?? 0,
      },
    });
    return true;
  }

  private handleSession(args: string[]): boolean {
    if (args.length > 0) {
      this.notice("Usage: /session", tones.invalid);
      return true;
    }
    const controller = this.#sessionController;
    if (controller === null || controller.currentSessionId === null) {
      this.notice("No active session.", "warning");
      return true;
    }
    this.notice(
      `Current session: ${controller.currentSessionId}\nPath: ${controller.currentPath ?? ""}`,
      "info",
    );
    return true;
  }

  private async handleNew(args: string[]): Promise<boolean> {
    if (args.length > 0) {
      this.notice("Usage: /new", tones.invalid);
      return true;
    }
    const controller = this.#sessionController;
    if (controller === null) {
      this.notice("Session creation is unavailable.", "error");
      return true;
    }
    await controller.createNew();
    await this.#onSessionChanged?.();
    this.notice("Started a new session.", tones.switched);
    return true;
  }

  private handleSessions(args: string[]): boolean {
    if (args.length > 0) {
      this.notice("Usage: /sessions", tones.invalid);
      return true;
    }
    const sessions = this.#sessionController?.list() ?? [];
    if (sessions.length === 0) {
      this.notice("No sessions for this project.", "info");
      return true;
    }
    const now = this.#now();
    for (const session of sessions) {
      this.notice(
        `${sessionDisplayTitle(session)}\n${sessionDisplayDescription(session, {
          homeDirectory: this.#homeDirectory,
          now,
        })}`,
        "info",
      );
    }
    return true;
  }

  private async handleResume(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.notice("Usage: /resume [session-id]", tones.invalid);
      return true;
    }
    const controller = this.#sessionController;
    if (controller === null) {
      this.notice("Session resume is unavailable.", "error");
      return true;
    }
    let sessionId = args[0];
    if (sessionId === undefined) {
      const sessions = controller.list();
      if (sessions.length === 0) {
        this.notice("No sessions for this project.", "info");
        return true;
      }
      const now = this.#now();
      sessionId = await this.#presenter.select({
        id: "session-resume",
        title: "Resume session",
        items: sessions.map((session) => ({
          value: session.sessionId,
          label: sessionDisplayTitle(session),
          description: sessionDisplayDescription(session, {
            homeDirectory: this.#homeDirectory,
            now,
          }),
        })),
        currentValue: controller.currentSessionId ?? undefined,
        searchable: true,
        searchPlaceholder: "Search sessions",
        maxVisible: 20,
      }) ?? undefined;
      if (sessionId === undefined) {
        return true;
      }
    }
    await controller.resume(sessionId);
    await this.#onSessionChanged?.();
    this.notice("Resumed session.", tones.switched);
    return true;
  }

  private async handleFork(args: string[]): Promise<boolean> {
    if (
      args.length < 1 ||
      args.length > 2 ||
      (args[1] !== undefined && args[1] !== "before" && args[1] !== "at")
    ) {
      this.notice("Usage: /fork <entry-id> [before|at]", tones.invalid);
      return true;
    }
    const controller = this.#sessionController;
    if (controller === null) {
      this.notice("Session fork is unavailable.", "error");
      return true;
    }
    const result = await controller.fork(args[0]!, args[1] ?? "before");
    await this.#onSessionChanged?.();
    if (result.editorText !== "") {
      this.#onComposerText?.(result.editorText);
    }
    this.notice(`Forked session ${result.sessionId}.`, tones.switched);
    return true;
  }

  private async handleClone(args: string[]): Promise<boolean> {
    if (args.length > 0) {
      this.notice("Usage: /clone", tones.invalid);
      return true;
    }
    const controller = this.#sessionController;
    if (controller === null) {
      this.notice("Session clone is unavailable.", "error");
      return true;
    }
    const result = await controller.clone();
    await this.#onSessionChanged?.();
    this.notice(`Cloned session ${result.sessionId}.`, tones.switched);
    return true;
  }

  private async handleCompact(args: string[]): Promise<boolean> {
    if (args.length > 0) {
      this.notice("Usage: /compact", tones.invalid);
      return true;
    }
    if (this.#sessionController === null) {
      this.notice("Session compaction is unavailable.", "error");
      return true;
    }
    await this.#sessionController.compact();
    await this.#onSessionChanged?.();
    this.notice("Compacted current session.", tones.switched);
    return true;
  }

  private async handleModel(args: string[]): Promise<boolean> {
    if (args.length === 1 && args[0] === "current") {
      this.notice(
        `Current model: ${this.#currentConfig.provider} / ` +
          `${this.#currentConfig.model}`,
        "info",
      );
      return true;
    }
    if (args.length > 2) {
      this.notice("Usage: /model [provider|model] [model]", "error");
      return true;
    }

    let provider: string;
    let modelName: string | undefined;
    if (args.length === 0) {
      const selectedProvider = await this.selectModelProvider();
      if (selectedProvider === null) {
        return true;
      }
      provider = selectedProvider;
    } else if (args.length === 2) {
      provider = args[0]!;
      modelName = args[1];
    } else {
      const argument = args[0]!;
      if (this.#catalog.getProvider(argument) !== undefined) {
        provider = argument;
      } else {
        provider = this.#currentConfig.provider;
        modelName = argument;
      }
    }

    if (modelName === undefined) {
      try {
        const models = await this.#selector.listModels(provider, "");
        if (models.length === 0) {
          this.notice(`No models available for provider: ${provider}`, "error");
          return true;
        }
        if (this.#presenter === null) {
          this.notice("Model selection is unavailable.", "error");
          return true;
        }
        const selected = await this.#presenter.select({
          id: "model-name",
          title: `Select model for ${provider}`,
          items: models.map((model) => ({
            value: `${provider}/${model.id}`,
            label: model.name,
            description: provider,
          })),
          currentValue: this.#currentConfig.provider === provider
            ? `${provider}/${this.#currentConfig.model}`
            : undefined,
          searchable: true,
          maxVisible: 20,
        });
        if (selected === null) {
          return true;
        }
        const prefix = `${provider}/`;
        modelName = selected.startsWith(prefix) ? selected.slice(prefix.length) : selected;
      } catch (error) {
        this.notice(`Could not list models: ${errorMessage(error)}`, "error");
        return true;
      }
    }

    let selection: ModelSelection | null;
    try {
      selection = await this.#selector.selectExact({
        providerName: provider,
        modelName,
        promptForMissingKey: false,
      });
    } catch (error) {
      this.notice(`Could not switch model: ${errorMessage(error)}`, "error");
      return true;
    }
    if (selection === null) {
      return true;
    }
    const previousProvider = this.#currentConfig.provider;
    const previousModel = this.#currentConfig.model;
    this.#agent.switchModel({
      model: selection.config.model,
      provider: selection.config.provider,
      baseUrl: selection.config.baseUrl,
    });
    this.#onModelSelected?.(selection);
    this.#currentConfig = selection.config;
    this.adjustReasoningEffortForCurrentModel({ emitNotice: true });
    this.publishModelSwitched(previousProvider, previousModel);
    this.notice(
      `Switched to ${selection.config.provider} / ${selection.config.model}`,
      "success",
    );
    return true;
  }

  private async handleEffort(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.notice(
        "Usage: /effort [current|off|minimal|low|medium|high|xhigh|max]",
        "error",
      );
      return true;
    }
    const requested = args[0];
    if (requested === "current") {
      this.notice(`Current effort: ${this.currentReasoningEffort()}`, "info");
      return true;
    }
    if (requested === undefined) {
      if (this.#presenter === null) {
        this.notice("Effort selection is unavailable.", "error");
        return true;
      }
      const selected = await this.#presenter.select({
        id: "model-effort",
        title: `Reasoning effort for ${this.#currentConfig.provider} / ${this.#currentConfig.model}`,
        items: this.supportedReasoningEfforts().map((effort) => ({
          value: effort,
          label: effort,
          description: effort === "off" ? "Disable reasoning" : undefined,
        })),
        currentValue: this.currentReasoningEffort(),
      });
      if (selected !== null) {
        if (!isReasoningEffort(selected)) {
          this.notice(`Invalid effort selection: ${selected}`, "error");
          return true;
        }
        const supported = this.supportedReasoningEfforts();
        if (!supported.includes(selected)) {
          this.notice(
            `Effort ${selected} is not supported by ` +
              `${this.#currentConfig.provider} / ${this.#currentConfig.model}. ` +
              `Supported: ${supported.join(", ")}`,
            "error",
          );
          return true;
        }
        this.setReasoningEffort(selected);
      }
      return true;
    }
    if (!isReasoningEffort(requested)) {
      this.notice(
        "Usage: /effort [current|off|minimal|low|medium|high|xhigh|max]",
        "error",
      );
      return true;
    }
    const supported = this.supportedReasoningEfforts();
    if (!supported.includes(requested)) {
      this.notice(
        `Effort ${requested} is not supported by ` +
          `${this.#currentConfig.provider} / ${this.#currentConfig.model}. ` +
          `Supported: ${supported.join(", ")}`,
        "error",
      );
      return true;
    }
    this.setReasoningEffort(requested);
    return true;
  }

  private async handleLogin(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.notice("Usage: /login [provider]", tones.invalid);
      return true;
    }
    const provider = args[0] ?? (await this.chooseProvider());
    if (provider === null || provider === undefined) {
      return true;
    }
    if (this.#catalog.getProvider(provider) === undefined) {
      this.notice(`Unknown provider: ${provider}`, tones.invalid);
      return true;
    }
    try {
      const status = await this.#providerAuth.login(
        provider,
        this.authPrompts(provider),
      );
      if (status === null) {
        this.notice(
          "Login cancelled; credentials were not changed.",
          tones.cancelled,
        );
      } else if (status.configured) {
        this.notice(
          `Logged in to ${provider}; use /model to select it.`,
          tones.switched,
        );
      } else {
        this.notice(`Login did not configure ${provider}.`, "warning");
      }
    } catch (error) {
      this.notice(
        `Login failed for ${provider}: ${errorMessage(error)}`,
        tones.invalid,
      );
    }
    return true;
  }

  private async handleLogout(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.notice("Usage: /logout [provider]", tones.invalid);
      return true;
    }
    const provider = args[0] ?? (await this.chooseProvider());
    if (provider === null || provider === undefined) {
      return true;
    }
    if (this.#catalog.getProvider(provider) === undefined) {
      this.notice(`Unknown provider: ${provider}`, tones.invalid);
      return true;
    }
    try {
      await this.#providerAuth.logout(provider);
      const status = await this.#providerAuth.status(provider);
      if (status.configured) {
        this.notice(
          `Removed stored credentials for ${provider}, but it is still configured via ${status.source}.`,
          "warning",
        );
        return true;
      }
      const suffix =
        this.#currentConfig.provider === provider
          ? " The current client remains active until you switch models or exit."
          : "";
      this.notice(`Logged out of ${provider}.${suffix}`, tones.cleared);
    } catch (error) {
      this.notice(
        `Could not log out of ${provider}: ${errorMessage(error)}`,
        tones.invalid,
      );
    }
    return true;
  }

  /** Compatibility alias for the pre-/login credential commands. */
  private async handleApiKey(args: string[]): Promise<boolean> {
    const first = args[0];
    if (first === undefined) {
      await this.handleProviders([]);
      return true;
    }
    if (first === "set") {
      return this.handleLogin(args.slice(1));
    }
    if (first === "remove") {
      return this.handleLogout(args.slice(1));
    }
    this.notice("Usage: /apikey [set|remove] [provider]", tones.invalid);
    return true;
  }

  private async handleProviders(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.notice("Usage: /providers [provider]", tones.invalid);
      return true;
    }
    const providerId = args[0];
    if (providerId !== undefined) {
      const provider = this.#catalog.getProvider(providerId);
      if (provider === undefined) {
        this.notice(`Unknown provider: ${providerId}`, tones.invalid);
        return true;
      }
      await this.reportProviderDetail(provider);
      return true;
    }
    const providers = this.#catalog.listProviders();
    const statuses = await Promise.all(
      providers.map((provider) => this.providerStatus(provider.id)),
    );
    this.#presenter.providers({
      providers: providers.map((provider, index) => {
        const status = statuses[index]!;
        return {
          id: provider.id,
          name: provider.name,
          available: true,
          configured: status.configured,
          verified: provider.verified,
          source: status.configured ? status.source ?? null : null,
        };
      }),
    });
    return true;
  }

  private publishModelSwitched(
    previousProvider: string,
    previousModel: string,
  ): void {
    const eventBus = this.#session?.eventBus ?? null;
    const sessionId = this.#session?.sessionId ?? null;
    if (eventBus === null || sessionId === null) {
      return;
    }
    eventBus.publish(EventKind.ModelSwitched, {
      source: EventSource.Session,
      session_id: sessionId,
      payload: {
        provider: this.#currentConfig.provider,
        model: this.#currentConfig.model,
        context_window: this.#catalog.getModel(
          this.#currentConfig.provider,
          this.#currentConfig.model,
        )?.contextWindow ?? 0,
        previous_provider: previousProvider,
        previous_model: previousModel,
      },
    });
  }

  private async chooseProvider(): Promise<string | null> {
    const providers = this.#catalog.listProviders();
    return this.#presenter.select({
      id: "auth-provider",
      title: "Select provider",
      items: providers.map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.id,
      })),
      currentValue: this.#currentConfig.provider,
    });
  }

  private authPrompts(provider: string): AuthPromptHandler {
    return {
      prompt: (request) => this.#presenter.prompt(
        request.kind === "select"
          ? {
              id: `auth-${provider}`,
              kind: request.kind,
              message: request.message,
              items: (request.options ?? []).map((item) => ({
                value: item.id,
                label: item.label,
                ...(item.description === undefined
                  ? {}
                  : { description: item.description }),
              })),
            }
          : {
              id: `auth-${provider}`,
              kind: request.kind,
              message: request.message,
            },
      ),
    };
  }

  private async selectModelProvider(): Promise<string | null> {
    if (this.#presenter === null) {
      this.notice("Model provider selection is unavailable.", "error");
      return null;
    }
    const selected = await this.#presenter.select({
      id: "model-provider",
      title: "Select model provider",
      items: this.#selector.listProviders().map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.id,
      })),
      currentValue: this.#currentConfig.provider,
    });
    return selected;
  }

  private *modelCompletions(
    args: readonly string[],
  ): Iterable<readonly [string, string]> {
    if (args.length === 0) {
      yield ["current", "显示当前模型"] as const;
      for (const model of this.#catalog.listModels(this.#currentConfig.provider)) {
        yield [model.id, `${this.#currentConfig.provider} 模型`] as const;
      }
      for (const provider of this.#catalog.listProviders()) {
        yield [provider.id, "模型供应商"] as const;
      }
      return;
    }
    if (args.length === 1) {
      const provider = this.#catalog.getProvider(args[0]!);
      if (provider === undefined) {
        return;
      }
      for (const model of this.#catalog.listModels(provider.id)) {
        yield [model.id, `${provider.name} 模型`] as const;
      }
    }
  }

  private *effortCompletions(
    args: readonly string[],
  ): Iterable<readonly [string, string]> {
    if (args.length > 0) {
      return;
    }
    yield ["current", "当前思考等级"] as const;
    for (const effort of this.supportedReasoningEfforts()) {
      yield [effort, effort === "off" ? "关闭思考" : "设置思考等级"] as const;
    }
  }

  private *resumeCompletions(
    args: readonly string[],
  ): Iterable<readonly [string, string]> {
    if (args.length > 0) {
      return;
    }
    for (const session of this.#sessionController?.list() ?? []) {
      const description = session.lastUserText === undefined || session.lastUserText === ""
        ? session.updatedAt
        : `${session.updatedAt}  ${session.lastUserText}`;
      yield [session.sessionId, description] as const;
    }
  }

  private currentReasoningEffort(): ReasoningEffort {
    return this.#agent.getReasoningEffort?.() ?? "high";
  }

  private setReasoningEffort(effort: ReasoningEffort): void {
    this.#agent.setReasoningEffort?.(effort);
    this.notice(
      `Effort set to ${effort}. Applies to the next model request.`,
      "success",
    );
  }

  private adjustReasoningEffortForCurrentModel(options: {
    emitNotice: boolean;
  }): void {
    const current = this.currentReasoningEffort();
    const adjusted = clampReasoningEffort(this.supportedReasoningEfforts(), current);
    if (adjusted === current) {
      return;
    }
    this.#agent.setReasoningEffort?.(adjusted);
    if (options.emitNotice) {
      this.notice(
        `Reasoning effort adjusted to ${adjusted} for ` +
          `${this.#currentConfig.provider} / ${this.#currentConfig.model}.`,
        "info",
      );
    }
  }

  private supportedReasoningEfforts(): readonly ReasoningEffort[] {
    const model = this.#catalog.getModel(
      this.#currentConfig.provider,
      this.#currentConfig.model,
    );
    return model?.supportedReasoningEfforts ?? ["off"];
  }

  private *providerCompletions(
    args: readonly string[],
  ): Iterable<readonly [string, string]> {
    if (args.length === 0) {
      for (const provider of this.#catalog.listProviders()) {
        yield [provider.id, "模型供应商"] as const;
      }
    }
  }

  private async reportProviderDetail(
    provider: ModelProviderInfo,
  ): Promise<void> {
    const status = await this.providerStatus(provider.id);
    this.#presenter.providerDetail({
      provider: {
        id: provider.id,
        name: provider.name,
        available: true,
        configured: status.configured,
        verified: provider.verified,
        source: status.configured ? status.source ?? null : null,
        dynamicModels: provider.dynamicModels,
        modelCount: this.#catalog.listModels(provider.id).length,
      },
    });
  }

  private async providerStatus(provider: string): Promise<ModelAuthStatus> {
    try {
      return await this.#providerAuth.status(provider);
    } catch {
      return { configured: false };
    }
  }

  private notice(
    text: string,
    tone: "info" | "success" | "warning" | "error",
  ): void {
    this.#presenter.notice({ text, tone });
  }
}
