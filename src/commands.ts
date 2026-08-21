/** Slash commands available inside an interactive agent session. */

import { EventKind, EventSource } from "./events.ts";
import type {
  InputFn,
  ModelSelection,
  ModelSelector,
  OutputFn,
  SelectionConfig,
} from "./model-selection.ts";
import { getProvider, providerNames } from "./providers.ts";
import type { CompletionItem } from "./terminal/editor.ts";

// The canonical CompletionItem lives in terminal/editor.ts; re-exported here
// so the command layer and consumers share one definition.
export type { CompletionItem } from "./terminal/editor.ts";

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
export function shlexSplit(text: string): string[] {
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

  async dispatch(command: string, options: { state?: string } = {}): Promise<boolean> {
    let parts: string[];
    try {
      parts = shlexSplit(command);
    } catch {
      return false;
    }
    const first = parts[0];
    if (first === undefined) {
      return false;
    }
    const spec = this.get(first);
    if (spec === undefined || spec.handler === undefined) {
      return false;
    }
    if (
      spec.allowedStates !== undefined &&
      spec.allowedStates.size > 0 &&
      (options.state === undefined || !spec.allowedStates.has(options.state))
    ) {
      return false;
    }
    return spec.handler(parts.slice(1));
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

function* modelCompletions(
  args: readonly string[],
): Iterable<readonly [string, string]> {
  if (args.length === 0) {
    yield ["current", "显示当前模型"] as const;
    for (const name of providerNames()) {
      yield [name, "模型供应商"] as const;
    }
    return;
  }
  if (args.length === 1) {
    let provider;
    try {
      provider = getProvider(args[0]!);
    } catch {
      return;
    }
    for (const model of provider.suggestedModels) {
      yield [model, `${provider.name} 模型`] as const;
    }
  }
}

function* queueCompletions(
  args: readonly string[],
): Iterable<readonly [string, string]> {
  if (args.length === 0) {
    yield ["resume", "恢复保留的消息"] as const;
    yield ["clear", "清空待处理和保留消息"] as const;
  }
}

function* providerCompletions(
  args: readonly string[],
): Iterable<readonly [string, string]> {
  if (args.length === 0) {
    for (const name of providerNames()) {
      yield [name, "模型供应商"] as const;
    }
  }
}

// --- Structural views of modules owned by other workstreams ------------------

/** Minimal view of CodingAgent (agent.ts) that session commands rely on. */
export interface AgentLike {
  switchModel(options: {
    client: unknown;
    model: string;
    provider: string;
  }): void;
  clearHistory?(): void;
  /** Conversation history, trimmed in place when no clearHistory exists. */
  messages?: unknown[] | undefined;
}

/** Aggregate queue counters returned by AgentSession.queueStatus. */
export interface QueueStatus {
  readonly pending?: number | undefined;
  readonly pendingTokens?: number | undefined;
  readonly held?: number | undefined;
  readonly heldTokens?: number | undefined;
  readonly deadLetters?: number | undefined;
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
  clearQueues(): number;
  resumeHeld(): number;
  queueStatus(): QueueStatus;
}

/** Minimal view of CredentialStore (credentials.ts). */
export interface CredentialStoreLike {
  get(provider: string): string | null;
  set(provider: string, apiKey: string): void;
  remove(provider: string): boolean;
  providers(): string[];
}

export interface SessionCommandsOptions {
  readonly agent: AgentLike;
  readonly selector: ModelSelector;
  readonly credentials: CredentialStoreLike;
  readonly currentConfig: SelectionConfig;
  readonly input: InputFn;
  readonly secretInput: InputFn;
  readonly output?: OutputFn | undefined;
  readonly session?: SessionLike | null | undefined;
}

const ALL_STATES: ReadonlySet<string> = new Set([
  "IDLE",
  "RUNNING_MODEL",
  "RUNNING_TOOLS",
  "CANCELLING",
  "FAILED",
]);
const IDLE_ONLY: ReadonlySet<string> = new Set(["IDLE", "FAILED"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Handle session-local model and credential commands. */
export class SessionCommands {
  readonly registry: CommandRegistry;

  readonly #agent: AgentLike;
  readonly #selector: ModelSelector;
  readonly #credentials: CredentialStoreLike;
  readonly #input: InputFn;
  readonly #secretInput: InputFn;
  readonly #output: OutputFn;
  readonly #session: SessionLike | null;
  #currentConfig: SelectionConfig;

  constructor(options: SessionCommandsOptions) {
    this.#agent = options.agent;
    this.#selector = options.selector;
    this.#credentials = options.credentials;
    this.#currentConfig = options.currentConfig;
    this.#input = options.input;
    this.#secretInput = options.secretInput;
    this.#output = options.output ?? ((message) => console.log(message));
    this.#session = options.session ?? null;
    this.registry = new CommandRegistry([
      {
        name: "/model",
        description: "选择供应商和模型",
        usage: "/model [provider] [model]",
        handler: (args) => this.handleModel(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: modelCompletions,
      },
      {
        name: "/login",
        description: "输入或更新API Key",
        usage: "/login [provider]",
        handler: (args) => this.handleLogin(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: providerCompletions,
      },
      {
        name: "/logout",
        description: "删除保存的API Key",
        usage: "/logout [provider]",
        handler: (args) => this.handleLogout(args),
        allowedStates: IDLE_ONLY,
        argumentCompleter: providerCompletions,
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
        name: "/clear",
        description: "清空当前对话上下文",
        usage: "/clear",
        handler: (args) => this.handleClear(args),
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
  }

  get currentConfig(): SelectionConfig {
    return this.#currentConfig;
  }

  async handle(command: string): Promise<boolean> {
    let parts: string[];
    try {
      parts = shlexSplit(command);
    } catch (error) {
      this.#output(`Invalid command: ${errorMessage(error)}`);
      return true;
    }
    const first = parts[0];
    if (first === undefined) {
      return false;
    }

    const spec = this.registry.get(first);
    if (spec === undefined || spec.handler === undefined) {
      return false;
    }
    const state = this.runtimeState();
    const readOnlyModelQuery =
      parts.length === 2 && parts[0] === "/model" && parts[1] === "current";
    if (
      spec.allowedStates !== undefined &&
      spec.allowedStates.size > 0 &&
      !spec.allowedStates.has(state) &&
      !readOnlyModelQuery
    ) {
      this.#output(
        `${spec.name} is unavailable while the task is ${state.toLowerCase()}.`,
      );
      return true;
    }
    return spec.handler(parts.slice(1));
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
      this.#output("Usage: /help");
      return true;
    }
    this.#output("Commands:");
    for (const spec of this.registry.all()) {
      this.#output(`  ${spec.usage.padEnd(32)} ${spec.description}`);
    }
    return true;
  }

  private handleCancel(args: string[]): boolean {
    if (args.length > 0) {
      this.#output("Usage: /cancel");
      return true;
    }
    if (this.#session === null) {
      this.#output("No active task to cancel.");
      return true;
    }
    const cancelled = this.#session.cancelActiveTask();
    this.#output(
      cancelled ? "Cancelling current task…" : "No active task to cancel.",
    );
    return true;
  }

  private handleQueue(args: string[]): boolean {
    if (
      args.length > 1 ||
      (args.length > 0 && args[0] !== "resume" && args[0] !== "clear")
    ) {
      this.#output("Usage: /queue [resume|clear]");
      return true;
    }
    if (this.#session === null) {
      this.#output("Pending: 0 · Held: 0 · Dead letters: 0");
      return true;
    }
    if (args[0] === "clear") {
      const cleared = this.#session.clearQueues();
      this.#output(`Cleared ${cleared} queued message(s).`);
      return true;
    }
    if (args[0] === "resume") {
      const resumed = this.#session.resumeHeld();
      this.#output(`Resumed ${resumed} held message(s).`);
      return true;
    }
    const status = this.#session.queueStatus();
    this.#output(
      `Pending: ${status.pending ?? 0}` +
        ` (${status.pendingTokens ?? 0} est. tokens)` +
        ` · Held: ${status.held ?? 0}` +
        ` (${status.heldTokens ?? 0} est. tokens)` +
        ` · Dead letters: ${status.deadLetters ?? 0}`,
    );
    return true;
  }

  private handleClear(args: string[]): boolean {
    if (args.length > 0) {
      this.#output("Usage: /clear");
      return true;
    }
    const clear = this.#agent.clearHistory;
    if (typeof clear === "function") {
      clear.call(this.#agent);
    } else if (this.#agent.messages !== undefined && this.#agent.messages.length > 0) {
      this.#agent.messages.splice(1);
    }
    this.#output("Conversation cleared.");
    return true;
  }

  private async handleModel(args: string[]): Promise<boolean> {
    if (args.length === 1 && args[0] === "current") {
      this.#output(
        `Current model: ${this.#currentConfig.provider} / ` +
          `${this.#currentConfig.model}`,
      );
      return true;
    }
    if (args.length > 2) {
      this.#output("Usage: /model [provider] [model]");
      return true;
    }

    const provider = args[0];
    const model = args.length === 2 ? args[1] : undefined;
    let selection: ModelSelection | null;
    try {
      selection = await this.#selector.select({
        providerName: provider,
        modelName: model,
        promptForMissingKey: false,
      });
    } catch (error) {
      this.#output(`Could not switch model: ${errorMessage(error)}`);
      return true;
    }
    if (selection === null) {
      return true;
    }
    const previousProvider = this.#currentConfig.provider;
    const previousModel = this.#currentConfig.model;
    this.#agent.switchModel({
      client: selection.client,
      model: selection.config.model,
      provider: selection.config.provider,
    });
    this.#currentConfig = selection.config;
    this.publishModelSwitched(previousProvider, previousModel);
    this.#output(
      `Switched to ${selection.config.provider} / ${selection.config.model}`,
    );
    return true;
  }

  private async handleLogin(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.#output("Usage: /login [provider]");
      return true;
    }
    const provider = args[0] ?? (await this.chooseProvider());
    if (provider === null || provider === undefined) {
      return true;
    }
    try {
      getProvider(provider);
    } catch (error) {
      this.#output(errorMessage(error));
      return true;
    }

    let apiKey: string;
    try {
      apiKey = (await this.#secretInput(`Enter ${provider} API key: `)).trim();
    } catch {
      this.#output("Login cancelled; credentials were not changed.");
      return true;
    }
    if (!apiKey) {
      this.#output("Login cancelled; credentials were not changed.");
      return true;
    }
    this.#credentials.set(provider, apiKey);
    if (this.#currentConfig.provider === provider) {
      let selection: ModelSelection | null;
      try {
        selection = await this.#selector.select({
          providerName: provider,
          modelName: this.#currentConfig.model,
          promptForMissingKey: false,
        });
      } catch (error) {
        this.#output(
          `Credentials saved but could not be applied: ${errorMessage(error)}`,
        );
        return true;
      }
      if (selection !== null) {
        const previousProvider = this.#currentConfig.provider;
        const previousModel = this.#currentConfig.model;
        this.#agent.switchModel({
          client: selection.client,
          model: selection.config.model,
          provider: selection.config.provider,
        });
        this.#currentConfig = selection.config;
        this.publishModelSwitched(previousProvider, previousModel);
        this.#output(`Logged in to ${provider}; credentials applied.`);
        return true;
      }
    }
    this.#output(`Logged in to ${provider}; use /model to select it.`);
    return true;
  }

  private async handleLogout(args: string[]): Promise<boolean> {
    if (args.length > 1) {
      this.#output("Usage: /logout [provider]");
      return true;
    }
    const provider = args[0] ?? (await this.chooseProvider());
    if (provider === null || provider === undefined) {
      return true;
    }
    try {
      getProvider(provider);
    } catch (error) {
      this.#output(errorMessage(error));
      return true;
    }
    if (this.#credentials.remove(provider)) {
      const suffix =
        this.#currentConfig.provider === provider
          ? " The current client remains active until you switch models or exit."
          : "";
      this.#output(`Logged out of ${provider}.${suffix}`);
    } else {
      this.#output(`No credentials stored for ${provider}.`);
    }
    return true;
  }

  /** Compatibility alias for the pre-/login credential commands. */
  private async handleApiKey(args: string[]): Promise<boolean> {
    const first = args[0];
    if (first === undefined) {
      const configured = new Set(this.#credentials.providers());
      for (const provider of providerNames()) {
        const status = configured.has(provider)
          ? "configured"
          : "not configured";
        this.#output(`${provider}: ${status}`);
      }
      this.#output("Use /login or /logout to manage credentials.");
      return true;
    }
    if (first === "set") {
      return this.handleLogin(args.slice(1));
    }
    if (first === "remove") {
      return this.handleLogout(args.slice(1));
    }
    this.#output("Usage: /apikey [set|remove] [provider]");
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
        previous_provider: previousProvider,
        previous_model: previousModel,
      },
    });
  }

  private async chooseProvider(): Promise<string | null> {
    const providers = providerNames();
    providers.forEach((provider, index) => {
      this.#output(`  ${index + 1}. ${provider}`);
    });
    let answer: string;
    try {
      answer = (await this.#input("Select provider: ")).trim();
    } catch {
      this.#output("Provider selection cancelled.");
      return null;
    }
    const choice = Number(answer);
    const selected = Number.isInteger(choice) ? providers[choice - 1] : undefined;
    if (selected === undefined) {
      this.#output("Invalid provider selection.");
      return null;
    }
    return selected;
  }
}
