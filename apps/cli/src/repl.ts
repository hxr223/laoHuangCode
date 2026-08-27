/** REPL and terminal-loop helpers for the laohuang CLI. */

import { readSync } from "node:fs";

import { AgentError } from "@laohuang/agent-runtime";
import {
  makeFollowUpIntent,
  makePromptIntent,
  makeSteerIntent,
  type CommandResult,
  type QueueStatus,
  type SessionAction,
} from "@laohuang/runtime-protocol";
import {
  routeHumanIntent,
  type SessionState,
  type Submission,
} from "@laohuang/session-runtime";
import {
  PlainEventSink,
  PromptCancelledError,
  PromptEofError,
  StdTerminalDriver,
  TerminalUI,
  type LoopInputSource,
  type SubmitOptions,
} from "@laohuang/tui";

import type { InputFn as PromptFn } from "./model-selection.ts";
import type { CommandPresenter } from "./command-presentation.ts";

// REPL-facing input stays liberal (sync or async); the model selector and
// session commands require the stricter async `PromptFn` contract.
export type InputFn = (prompt: string) => string | Promise<string>;
export type OutputFn = (message: string) => void;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEofError(error: unknown): boolean {
  return (
    error instanceof PromptEofError ||
    (error instanceof Error &&
      (error.name === "PromptEofError" || error.name === "EOFError"))
  );
}

function isInterruptedError(error: unknown): boolean {
  return (
    error instanceof PromptCancelledError ||
    (error instanceof Error &&
      (error.name === "PromptCancelledError" ||
        error.name === "KeyboardInterrupt"))
  );
}

// ---------------------------------------------------------------------------
// Synchronous stdin line prompts (non-TTY and pre-loop setup questions)
// ---------------------------------------------------------------------------

// These blocking readers are the non-interactive fallback: before the
// terminal loop starts (first-run setup, pipes, tests) nothing else owns
// fd 0, so reading lines synchronously is safe. Once the interactive loop
// runs, questions must go through TerminalUI.prompt/promptSecret instead —
// see terminalUiPrompts below.
const stdinBuffer = { pending: "", eof: false };

function readLineFromStdin(): string {
  const chunk = Buffer.alloc(4096);
  for (;;) {
    const newline = stdinBuffer.pending.indexOf("\n");
    if (newline !== -1) {
      const line = stdinBuffer.pending.slice(0, newline);
      stdinBuffer.pending = stdinBuffer.pending.slice(newline + 1);
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (stdinBuffer.eof) {
      const rest = stdinBuffer.pending;
      stdinBuffer.pending = "";
      if (rest) {
        return rest;
      }
      throw new PromptEofError();
    }
    let bytesRead = 0;
    try {
      bytesRead = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        // A non-blocking fd 0: wait briefly and retry (mirrors blocking input).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      throw error;
    }
    if (bytesRead === 0) {
      stdinBuffer.eof = true;
      continue;
    }
    stdinBuffer.pending += chunk.toString("utf8", 0, bytesRead);
  }
}

/** Default replacement for Python's ``input(prompt)``. */
export function defaultInputFn(prompt: string): string {
  if (prompt) {
    process.stdout.write(prompt);
  }
  return readLineFromStdin();
}

/** Default replacement for Python's ``getpass.getpass(prompt)``. */
export function defaultSecretInputFn(prompt: string): string {
  if (prompt) {
    process.stderr.write(prompt);
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return readLineFromStdin();
  }
  // Echo-less read of one line on a TTY: raw mode, byte at a time.
  const byte = Buffer.alloc(1);
  let answer = "";
  process.stdin.setRawMode(true);
  try {
    for (;;) {
      const bytesRead = readSync(0, byte, 0, 1, null);
      if (bytesRead === 0) {
        throw new PromptEofError();
      }
      const value = byte[0]!;
      if (value === 0x03) {
        process.stderr.write("\n");
        throw new PromptCancelledError();
      }
      if (value === 0x04) {
        process.stderr.write("\n");
        throw new PromptEofError();
      }
      if (value === 0x0a || value === 0x0d) {
        break;
      }
      if (value === 0x7f || value === 0x08) {
        answer = [...answer].slice(0, -1).join("");
        continue;
      }
      answer += byte.toString("utf8", 0, 1);
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  process.stderr.write("\n");
  return answer;
}

// ---------------------------------------------------------------------------
// Terminal UI support detection
// ---------------------------------------------------------------------------

export interface TerminalSupportOptions {
  inputFn?: InputFn | undefined;
  outputFn?: OutputFn | undefined;
  stdin?: { isTTY?: boolean | undefined } | undefined;
  stdout?: { isTTY?: boolean | undefined } | undefined;
}

/** Only enable the interactive UI for the process's real TTY streams. */
export function supportsTerminalUI(options: TerminalSupportOptions = {}): boolean {
  if (options.inputFn !== undefined || options.outputFn !== undefined) {
    return false;
  }
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

// ---------------------------------------------------------------------------
// Legacy single-agent REPL (mirrors Python cli.run_repl)
// ---------------------------------------------------------------------------

export interface ReplAgentLike {
  run(text: string): string | Promise<string>;
}

export interface ReplUiLike {
  showWelcome(): void;
  prompt(): string | Promise<string>;
  showGoodbye(): void;
  showInterrupted(options?: { operation?: boolean }): void;
  showError(message: string): void;
  showAssistant(response: string): void;
  write(message: string): void;
  thinking?(): { close(): void } | null;
}

export async function runRepl(
  agent: ReplAgentLike,
  options: {
    commandHandler?: ((command: string) => boolean | Promise<boolean>) | undefined;
    inputFn?: ((prompt: string) => string | Promise<string>) | undefined;
    outputFn?: OutputFn | undefined;
    ui?: ReplUiLike | undefined;
  } = {},
): Promise<void> {
  const inputFn = options.inputFn ?? defaultInputFn;
  const outputFn = options.outputFn ?? ((message) => console.log(message));
  const ui = options.ui ?? null;

  if (ui !== null) {
    ui.showWelcome();
  } else {
    outputFn("laoHuangCode is ready. Type /help for commands or /exit to quit.");
  }

  for (;;) {
    let userInput: string;
    try {
      userInput = (await (ui !== null ? ui.prompt() : inputFn("\nyou> "))).trim();
    } catch (error) {
      if (isEofError(error)) {
        if (ui !== null) {
          ui.showGoodbye();
        } else {
          outputFn("\nGoodbye.");
        }
        return;
      }
      if (isInterruptedError(error)) {
        if (ui !== null) {
          ui.showInterrupted();
        } else {
          outputFn("\nInterrupted. Type /exit to quit.");
        }
        continue;
      }
      throw error;
    }

    if (userInput === "/exit") {
      if (ui !== null) {
        ui.showGoodbye();
      } else {
        outputFn("Goodbye.");
      }
      return;
    }
    if (!userInput) {
      continue;
    }
    if (userInput.startsWith("/")) {
      if (
        options.commandHandler !== undefined &&
        (await options.commandHandler(userInput))
      ) {
        continue;
      }
      const message = `Unknown command: ${userInput.split(/\s/)[0] ?? userInput}`;
      if (ui !== null) {
        ui.write(message);
      } else {
        outputFn(message);
      }
      continue;
    }

    let response: string;
    try {
      if (ui !== null && typeof ui.thinking === "function") {
        const thinking = ui.thinking();
        try {
          response = await agent.run(userInput);
        } finally {
          thinking?.close();
        }
      } else {
        response = await agent.run(userInput);
      }
    } catch (error) {
      if (error instanceof AgentError) {
        if (ui !== null) {
          ui.showError(error.message);
        } else {
          outputFn(`\nError: ${error.message}`);
        }
      } else if (isInterruptedError(error)) {
        if (ui !== null) {
          ui.showInterrupted({ operation: true });
        } else {
          outputFn("\nOperation interrupted.");
        }
      } else {
        throw error;
      }
      continue;
    }
    if (ui !== null) {
      ui.showAssistant(response);
    } else {
      outputFn(`\nlaoHuangCode> ${response}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Session REPLs (mirrors Python cli.run_session_repl / run_plain_session_repl)
// ---------------------------------------------------------------------------

/** Minimal structural view of AgentSession the REPL loops rely on. */
export interface SessionReplSession {
  readonly state: SessionState;
  readonly eventBus: { flush(): Promise<unknown> };
  submitInput(content: string): Promise<Submission>;
  submitAction(action: SessionAction): Promise<Submission | CommandResult | boolean>;
  promotePendingToSteer(): number;
  queueStatus(): QueueStatus;
  publishNotice(text: string, options?: { style?: string }): unknown;
  waitForIdle(timeoutMs?: number): Promise<boolean>;
  close(options?: { wait?: boolean; timeoutMs?: number }): Promise<boolean>;
}

export interface SessionUiLike {
  commandRegistry?: unknown;
  renderError?: unknown;
  showWelcome?(): void;
  showGoodbye?(): void;
  showError?(message: string): void;
  prompt?: unknown;
  run?(onSubmit: (text: string, options?: SubmitOptions) => void): void | Promise<void>;
  requestExit?(): void;
  close?(): void;
  startEventRenderer?(): void;
  stopEventRenderer?(): void;
  flushEventRenderer?(): void;
}

export type CommandHandler = (command: string) => CommandResult | Promise<CommandResult>;

interface SubmissionRequest {
  readonly text: string;
  readonly options?: SubmitOptions;
}

function suggestCommand(ui: SessionUiLike | null, name: string): string | null {
  const registry = ui?.commandRegistry as
    | { suggest?: (command: string) => string | null }
    | null
    | undefined;
  return typeof registry?.suggest === "function" ? registry.suggest(name) : null;
}

function presentNotice(
  session: SessionReplSession,
  presenter: CommandPresenter | undefined,
  text: string,
  tone: "info" | "success" | "warning" | "error",
  legacyStyle?: string,
): void {
  if (presenter !== undefined) {
    presenter.notice({ text, tone });
    return;
  }
  session.publishNotice(
    text,
    legacyStyle === undefined ? undefined : { style: legacyStyle },
  );
}

/**
 * Shared input routing for the session REPLs. Returns false only for /exit,
 * which the persistent loop reports back to the terminal instead.
 */
async function handleSessionInput(
  session: SessionReplSession,
  commandHandler: CommandHandler | undefined,
  ui: SessionUiLike | null,
  presenter: CommandPresenter | undefined,
  userInput: string,
  options: SubmitOptions = {},
): Promise<boolean> {
  if (!userInput && options.strategy !== "steer") {
    return true;
  }
  if (!userInput) {
    const promoted = session.promotePendingToSteer();
    presentNotice(
      session,
      presenter,
      promoted > 0
        ? `Steered ${promoted} queued message(s).`
        : "No queued message to steer.",
      promoted > 0 ? "success" : "warning",
    );
    return true;
  }
  const intent = options.strategy === "steer"
    ? makeSteerIntent(userInput, "editor")
    : options.strategy === "follow_up"
      ? makeFollowUpIntent(userInput, "editor")
      : makePromptIntent(userInput, "editor");
  let action: SessionAction;
  let result: Submission | CommandResult | boolean;
  let submission: Submission;
  try {
    action = routeHumanIntent(intent, session.state);
    if (action.type === "exit") {
      return false;
    }
    result = await session.submitAction(action);
  } catch (error) {
    presentNotice(
      session,
      presenter,
      `Error: ${errorMessage(error)}`,
      "error",
      "bold red",
    );
    return true;
  }
  if (isCommandResult(result)) {
    return handleCommandResult(session, ui, presenter, result);
  }
  if (typeof result === "boolean") {
    if (action.type === "command") {
      const commandResult = result
        ? { status: "handled" } as const
        : commandHandler === undefined
          ? { status: "not_found", command: action.name } as const
          : await commandHandler(action.text ?? [action.name, ...action.arguments].join(" "));
      return handleCommandResult(session, ui, presenter, commandResult);
    }
    return true;
  }
  submission = result;
  if (submission.queued) {
    const status = session.queueStatus();
    presentNotice(
      session,
      presenter,
      options.strategy === "steer"
        ? `Message steered (pending ${status.pending ?? 0} · held ${status.held ?? 0}).`
        : `Message queued (pending ${status.pending ?? 0} · held ${status.held ?? 0}).`,
      "info",
    );
  } else if (submission.rejected) {
    presentNotice(
      session,
      presenter,
      `Message rejected: ${submission.reason}`,
      "error",
      "bold red",
    );
  }
  return true;
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { status?: unknown }).status === "string"
  );
}

async function handleCommandResult(
  session: SessionReplSession,
  ui: SessionUiLike | null,
  presenter: CommandPresenter | undefined,
  result: CommandResult,
): Promise<boolean> {
  if (result.status === "handled" || result.status === "blocked") {
    return true;
  }
  if (result.status === "exit_requested") {
    return false;
  }
  if (result.status === "error") {
    presentNotice(
      session,
      presenter,
      `Invalid command: ${errorMessage(result.error)}`,
      "error",
      "bold red",
    );
    return true;
  }
  const suggestion = suggestCommand(ui, result.command);
  const suffix = suggestion ? ` Did you mean ${suggestion}?` : "";
  presentNotice(
    session,
    presenter,
    `Unknown command: ${result.command}.${suffix}`,
    "info",
  );
  return true;
}

/** Keep accepting input while AgentSession executes in the background. */
export async function runSessionRepl(
  session: SessionReplSession,
  options: {
    commandHandler?: CommandHandler | undefined;
    presenter?: CommandPresenter | undefined;
    ui: SessionUiLike;
    /** Override for driving a UI whose run() does not read real stdin. */
    runUi?: ((onSubmit: (text: string, options?: SubmitOptions) => void) => void | Promise<void>) | undefined;
  },
): Promise<boolean> {
  if (options.runUi !== undefined || typeof options.ui.run === "function") {
    return runPersistentSessionRepl(session, options);
  }
  return runClassicSessionRepl(session, options);
}

async function runClassicSessionRepl(
  session: SessionReplSession,
  options: {
    commandHandler?: CommandHandler | undefined;
    presenter?: CommandPresenter | undefined;
    ui: SessionUiLike;
  },
): Promise<boolean> {
  const { commandHandler, presenter, ui } = options;
  ui.startEventRenderer?.();
  ui.showWelcome?.();
  let cleanShutdown = false;
  try {
    for (;;) {
      let userInput: string;
      try {
        const prompt = ui.prompt;
        if (typeof prompt !== "function") {
          throw new Error("Classic session UI requires a prompt function.");
        }
        userInput = (await (prompt as (this: SessionUiLike) => string | Promise<string>).call(ui)).trim();
      } catch (error) {
        if (isEofError(error)) {
          break;
        }
        if (isInterruptedError(error)) {
          presentNotice(session, presenter, "Interrupted.", "warning", "yellow");
          continue;
        }
        throw error;
      }
      const keepGoing = await handleSessionInput(
        session,
        commandHandler,
        ui,
        presenter,
        userInput,
      );
      if (!keepGoing) {
        break;
      }
    }
  } finally {
    cleanShutdown = await session.close({ wait: true, timeoutMs: 10_000 });
    if (cleanShutdown) {
      await session.eventBus.flush();
      ui.flushEventRenderer?.();
    }
    ui.stopEventRenderer?.();
  }
  if (cleanShutdown) {
    ui.showGoodbye?.();
  } else {
    if (options.presenter !== undefined) {
      options.presenter.notice({
        text: "Task worker did not stop before the shutdown timeout.",
        tone: "error",
      });
    } else {
      ui.showError?.("Task worker did not stop before the shutdown timeout.");
    }
  }
  return cleanShutdown;
}

interface Coordinator {
  submit(request: SubmissionRequest): void;
  stop(): void;
  readonly done: Promise<void>;
  readonly errors: unknown[];
  pending(): number;
}

/**
 * Serialize routing and command handling on one async worker so the terminal
 * loop never blocks on semantic classification (the Python original used a
 * dedicated coordinator thread fed by a queue).
 */
function startCoordinator(
  session: SessionReplSession,
  commandHandler: CommandHandler | undefined,
  ui: SessionUiLike,
  presenter: CommandPresenter | undefined,
): Coordinator {
  const queue: Array<SubmissionRequest | null> = [];
  let wake: (() => void) | null = null;
  let stopping = false;
  let unfinished = 0;
  const errors: unknown[] = [];
  const done = (async (): Promise<void> => {
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
      const item = queue.shift();
      if (item === undefined) {
        continue;
      }
      try {
        if (item === null || stopping) {
          return;
        }
        await handleSessionInput(
          session,
          commandHandler,
          ui,
          presenter,
          item.text,
          item.options ?? {},
        );
      } catch (error) {
        errors.push(error);
      } finally {
        unfinished -= 1;
      }
    }
  })();
  return {
    submit(request: SubmissionRequest): void {
      unfinished += 1;
      queue.push(request);
      wake?.();
    },
    stop(): void {
      stopping = true;
      queue.push(null);
      wake?.();
    },
    done,
    errors,
    pending(): number {
      return unfinished;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Resolve true when the promise settles within the timeout, false otherwise. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true as const,
    () => true as const,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForDrain(
  isDrained: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isDrained()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return isDrained();
    }
    await delay(5);
  }
}

/** Drive a single-renderer terminal without writing outside its layout. */
async function runPersistentSessionRepl(
  session: SessionReplSession,
  options: {
    commandHandler?: CommandHandler | undefined;
    presenter?: CommandPresenter | undefined;
    ui: SessionUiLike;
    runUi?: ((onSubmit: (text: string, options?: SubmitOptions) => void) => void | Promise<void>) | undefined;
  },
): Promise<boolean> {
  const { commandHandler, presenter, ui } = options;
  const runUi =
    options.runUi ??
    ((onSubmit: (text: string, options?: SubmitOptions) => void) => ui.run!(onSubmit));
  ui.showWelcome?.();
  const coordinator = startCoordinator(session, commandHandler, ui, presenter);
  let cleanShutdown = false;
  try {
    const enqueue = (userInput: string, submitOptions: SubmitOptions = {}): void => {
      // Local control operations should not wait behind a slow semantic
      // classification of an earlier queued message.
      if (userInput === "/exit" || submitOptions.strategy === "steer") {
        void (async () => {
          try {
            await handleSessionInput(
              session,
              commandHandler,
              ui,
              presenter,
              userInput,
              submitOptions,
            );
          } catch (error) {
            try {
              presentNotice(
                session,
                presenter,
                `Error: ${errorMessage(error)}`,
                "error",
                "bold red",
              );
            } catch {
              // The event bus may already be closed during shutdown.
            }
          }
        })();
        if (userInput === "/exit") {
          ui.requestExit?.();
        }
        return;
      }
      coordinator.submit({ text: userInput, options: submitOptions });
    };
    await runUi(enqueue);
  } finally {
    const queueDrained = await waitForDrain(() => coordinator.pending() === 0, 50);
    coordinator.stop();
    let coordinatorAlive = !(await settlesWithin(
      coordinator.done,
      queueDrained ? 2000 : 50,
    ));
    const sessionStopped = await session.close({ wait: true, timeoutMs: 10_000 });
    if (coordinatorAlive) {
      coordinatorAlive = !(await settlesWithin(coordinator.done, 250));
    }
    cleanShutdown =
      sessionStopped && !coordinatorAlive && coordinator.errors.length === 0;
    if (cleanShutdown) {
      await session.eventBus.flush();
      ui.flushEventRenderer?.();
    }
    const renderError = ui.renderError ?? null;
    try {
      if (!cleanShutdown && renderError === null) {
        const shutdownMessage = coordinatorAlive
          ? "Input coordinator did not stop before the shutdown timeout."
          : coordinator.errors.length > 0
            ? "Input coordinator failed during shutdown."
            : "Task worker did not stop before the shutdown timeout.";
        if (presenter !== undefined) {
          presenter.notice({ text: shutdownMessage, tone: "error" });
        } else {
          ui.showError?.(shutdownMessage);
        }
      }
    } finally {
      ui.close?.();
    }
  }
  const renderError = ui.renderError ?? null;
  return cleanShutdown && renderError === null;
}

/** Run the same event-driven session with append-only plain output. */
export async function runPlainSessionRepl(
  session: SessionReplSession,
  options: {
    commandHandler?: CommandHandler | undefined;
    inputFn?: ((prompt: string) => string | Promise<string>) | undefined;
    presenter?: CommandPresenter | undefined;
    sink: PlainEventSink;
  },
): Promise<boolean> {
  const inputFn = options.inputFn ?? defaultInputFn;
  const { commandHandler, sink } = options;
  session.publishNotice(
    "laoHuangCode is ready. Type /help for commands or /exit to quit.",
  );
  await session.eventBus.flush();
  sink.flush();
  let cleanShutdown = false;
  try {
    for (;;) {
      let userInput: string;
      try {
        userInput = (await inputFn("")).trim();
      } catch (error) {
        if (isEofError(error)) {
          // A pipe may close immediately after submitting work. Let the
          // active task and its compatible pending batch finish normally.
          await session.waitForIdle();
          break;
        }
        if (isInterruptedError(error)) {
          session.publishNotice("Interrupted. Type /exit to quit.");
          continue;
        }
        throw error;
      }
      const keepGoing = await handleSessionInput(
        session,
        commandHandler,
        null,
        options.presenter,
        userInput,
      );
      if (!keepGoing) {
        break;
      }
    }
  } finally {
    cleanShutdown = await session.close({ wait: true, timeoutMs: 10_000 });
    if (cleanShutdown) {
      await session.eventBus.flush();
      sink.flush();
    }
    sink.stop({ drain: cleanShutdown });
  }
  const output = sink.outputFn;
  if (cleanShutdown) {
    output("Goodbye.");
  } else {
    output("Error: Task worker did not stop before the shutdown timeout.");
  }
  return cleanShutdown;
}

// ---------------------------------------------------------------------------
// Production wiring helpers
// ---------------------------------------------------------------------------

/** Drive the interactive loop of a real TerminalUI with process stdin. */
export async function runTerminalUi(
  ui: TerminalUI,
  driver: StdTerminalDriver,
  onSubmit: (text: string, options?: SubmitOptions) => void,
): Promise<void> {
  const loop = ui.interactiveLoop;
  if (loop === null) {
    throw new Error("interactive terminal loop is unavailable");
  }
  // TerminalUI.run() does not forward an input source to the loop yet, so
  // the CLI starts the loop itself with the driver's stdin stream.
  loop.start(onSubmit);
  await loop.run(driver.inputStream as unknown as LoopInputSource);
}

/**
 * Route setup/command questions through the running terminal UI loop
 * (mirrors the Python original's `input_fn = terminal_ui.prompt` and
 * `session_secret_input_fn = terminal_ui.prompt_secret`). The loop's ask()
 * coordinates the question with its editor, so no pause/resume is needed —
 * and nothing reads fd 0 behind the driver's raw-mode stream.
 */
export function terminalUiPrompts(
  ui: Pick<TerminalUI, "prompt" | "promptSecret">,
): { input: PromptFn; secretInput: PromptFn } {
  return {
    input: (prompt) => ui.prompt(prompt),
    secretInput: (prompt) => ui.promptSecret(prompt),
  };
}
