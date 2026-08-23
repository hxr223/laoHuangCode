#!/usr/bin/env node
/** Command-line interface and subcommands for laoHuangCode. */

import { existsSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AgentError,
  CodingAgent,
  type ChatClientLike,
} from "./agent.ts";
import {
  createClient,
  type ClientConnectionSettings,
} from "./client.ts";
import { SessionCommands, type CommandResult, type QueueStatus } from "./commands.ts";
import {
  ConfigManager,
  defaultConfigPath,
  type Config,
} from "./config.ts";
import { CredentialStore } from "./credentials.ts";
import { EventProjector } from "./events.ts";
import { ModelSelector, type InputFn as PromptFn } from "./model-selection.ts";
import { getProvider, providerNames } from "./providers.ts";
import { findProjectRoot } from "./project-instructions.ts";
import { routeHumanIntent } from "./runtime/human-intent-router.ts";
import type { SessionAction } from "./runtime/session-action.ts";
import {
  makeCancelIntent,
  makeFollowUpIntent,
  makePromptIntent,
} from "./runtime/user-intent.ts";
import {
  SmallModelSemanticClassifier,
  type ChatCompletionsClient,
} from "./semantic-classifier.ts";
import { AgentSession, SessionState, type Submission } from "./session.ts";
import {
  BufferedInputKind,
  EditorState,
  InputActionKind,
  RawInputDecoder,
  StdinBuffer,
  TerminalInputFilter,
  inputAction,
  type InputAction,
} from "./terminal/editor.ts";
import { PromptCancelledError, PromptEofError } from "./terminal/input.ts";
import {
  PlainEventSink,
  StdTerminalDriver,
  TerminalUI,
  type CompletionItemLike,
  type EditorEffect,
  type EditorLike,
  type EditorRenderResult,
  type InputDecoderHooks,
  type InputDecoderLike,
  type LoopInputSource,
  type SubmitOptions,
} from "./terminal/ui.ts";
import { ToolRegistry } from "./tools.ts";
import { EventLog, WebDashboard, consumePullBuffer } from "./web.ts";

export const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(
      new URL("../package.json", import.meta.url),
    );
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the placeholder when the package manifest is missing.
  }
  return "0.0.0";
}

// REPL-facing input stays liberal (sync or async); the model selector and
// session commands require the stricter async `PromptFn` contract.
type InputFn = (prompt: string) => string | Promise<string>;
type OutputFn = (message: string) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
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
function defaultInputFn(prompt: string): string {
  if (prompt) {
    process.stdout.write(prompt);
  }
  return readLineFromStdin();
}

/** Default replacement for Python's ``getpass.getpass(prompt)``. */
function defaultSecretInputFn(prompt: string): string {
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
// Argument parsing (argparse-compatible surface)
// ---------------------------------------------------------------------------

class CliUsageError extends Error {}

const USAGE =
  "usage: laohuang [--version] [--profile PROFILE] [--model MODEL] " +
  "[--base-url BASE_URL] [--theme {auto,dark,light}] [--web] " +
  "[--web-port PORT] [config ...] [doctor]";

const HELP = `${USAGE}

A minimal coding agent

options:
  --version          show program's version number and exit
  -h, --help         show this help message and exit
  --profile PROFILE  model profile for this session
  --model MODEL      model override for this session
  --base-url URL     API base URL override for this session
  --theme THEME      interactive terminal theme: auto, dark, light (default: auto)
  --web              start the local agent trace dashboard
  --web-port PORT    dashboard port (default: 8765; use 0 for any free port)

subcommands:
  config [set|list|use] [target] [--profile P] [--provider P] [--model M] [--base-url U]
  doctor             check local configuration`;

interface ParsedArguments {
  command: "config" | "doctor" | null;
  profile: string | null;
  model: string | null;
  baseUrl: string | null;
  theme: string;
  web: boolean;
  webPort: number;
  configAction: "set" | "list" | "use";
  configTarget: string | null;
  configProfile: string;
  provider: string | null;
  configModel: string | null;
  configBaseUrl: string | null;
}

type ParseResult =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run"; args: ParsedArguments };

function splitOption(token: string): [string, string | undefined] {
  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    if (equals !== -1) {
      return [token.slice(0, equals), token.slice(equals + 1)];
    }
  }
  return [token, undefined];
}

function parseArgs(argv: readonly string[]): ParseResult {
  const args: ParsedArguments = {
    command: null,
    profile: null,
    model: null,
    baseUrl: null,
    theme: "auto",
    web: false,
    webPort: 8765,
    configAction: "set",
    configTarget: null,
    configProfile: "default",
    provider: null,
    configModel: null,
    configBaseUrl: null,
  };
  let index = 0;
  const takeValue = (option: string, inline: string | undefined): string => {
    if (inline !== undefined) {
      return inline;
    }
    index += 1;
    const value = argv[index];
    if (value === undefined) {
      throw new CliUsageError(`argument ${option}: expected one argument`);
    }
    return value;
  };

  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "config" || token === "doctor") {
      args.command = token;
      index += 1;
      break;
    }
    const [name, inline] = splitOption(token);
    switch (name) {
      case "--version":
        return { kind: "version" };
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--profile":
        args.profile = takeValue(name, inline);
        break;
      case "--model":
        args.model = takeValue(name, inline);
        break;
      case "--base-url":
        args.baseUrl = takeValue(name, inline);
        break;
      case "--theme": {
        const theme = takeValue(name, inline);
        if (theme !== "auto" && theme !== "dark" && theme !== "light") {
          throw new CliUsageError(
            `argument --theme: invalid choice: '${theme}' (choose from 'auto', 'dark', 'light')`,
          );
        }
        args.theme = theme;
        break;
      }
      case "--web":
        if (inline !== undefined) {
          throw new CliUsageError(`argument --web: ignored explicit argument`);
        }
        args.web = true;
        break;
      case "--web-port": {
        const raw = takeValue(name, inline);
        if (!/^[+-]?\d+$/.test(raw.trim())) {
          throw new CliUsageError(
            `argument --web-port: invalid int value: '${raw}'`,
          );
        }
        args.webPort = Number.parseInt(raw, 10);
        break;
      }
      default:
        throw new CliUsageError(`unrecognized arguments: ${token}`);
    }
  }

  if (args.command === "config") {
    const positionals: string[] = [];
    for (; index < argv.length; index += 1) {
      const token = argv[index]!;
      const [name, inline] = splitOption(token);
      switch (name) {
        case "--profile":
          args.configProfile = takeValue(name, inline);
          break;
        case "--provider": {
          const provider = takeValue(name, inline);
          if (!providerNames().includes(provider)) {
            throw new CliUsageError(
              `argument --provider: invalid choice: '${provider}' (choose from ${providerNames()
                .map((item) => `'${item}'`)
                .join(", ")})`,
            );
          }
          args.provider = provider;
          break;
        }
        case "--model":
          args.configModel = takeValue(name, inline);
          break;
        case "--base-url":
          args.configBaseUrl = takeValue(name, inline);
          break;
        case "-h":
        case "--help":
          return { kind: "help" };
        default:
          if (token.startsWith("-")) {
            throw new CliUsageError(`unrecognized arguments: ${token}`);
          }
          positionals.push(token);
      }
    }
    if (positionals.length > 2) {
      throw new CliUsageError(
        `unrecognized arguments: ${positionals.slice(2).join(" ")}`,
      );
    }
    const action = positionals[0];
    if (action !== undefined) {
      if (action !== "set" && action !== "list" && action !== "use") {
        throw new CliUsageError(
          `argument config_action: invalid choice: '${action}' (choose from 'set', 'list', 'use')`,
        );
      }
      args.configAction = action;
    }
    args.configTarget = positionals[1] ?? null;
  } else if (args.command === "doctor") {
    if (index < argv.length) {
      throw new CliUsageError(
        `unrecognized arguments: ${argv.slice(index).join(" ")}`,
      );
    }
  }
  return { kind: "run", args };
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
  prompt?(): string | Promise<string>;
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

/**
 * Shared input routing for the session REPLs. Returns false only for /exit,
 * which the persistent loop reports back to the terminal instead.
 */
async function handleSessionInput(
  session: SessionReplSession,
  commandHandler: CommandHandler | undefined,
  ui: SessionUiLike | null,
  userInput: string,
  options: SubmitOptions = {},
): Promise<boolean> {
  if (!userInput) {
    return true;
  }
  const intent = options.strategy === "follow_up"
    ? makeFollowUpIntent(userInput, "editor")
    : makePromptIntent(userInput, "editor");
  const action = routeHumanIntent(intent, session.state);
  if (action.type === "exit") {
    return false;
  }
  let result: Submission | CommandResult | boolean;
  let submission: Submission;
  try {
    result = await session.submitAction(action);
  } catch (error) {
    session.publishNotice(`Error: ${errorMessage(error)}`, { style: "bold red" });
    return true;
  }
  if (isCommandResult(result)) {
    return handleCommandResult(session, ui, result);
  }
  if (typeof result === "boolean") {
    if (action.type === "command") {
      const commandResult = result
        ? { status: "handled" } as const
        : commandHandler === undefined
          ? { status: "not_found", command: action.name } as const
          : await commandHandler(action.text ?? [action.name, ...action.arguments].join(" "));
      return handleCommandResult(session, ui, commandResult);
    }
    return true;
  }
  submission = result;
  if (submission.queued) {
    const status = session.queueStatus();
    session.publishNotice(
      `Message queued (pending ${status.pending ?? 0} · held ${status.held ?? 0}).`,
    );
  } else if (submission.rejected) {
    session.publishNotice(`Message rejected: ${submission.reason}`, {
      style: "bold red",
    });
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
  result: CommandResult,
): Promise<boolean> {
  if (result.status === "handled" || result.status === "blocked") {
    return true;
  }
  if (result.status === "exit_requested") {
    return false;
  }
  if (result.status === "error") {
    session.publishNotice(`Invalid command: ${errorMessage(result.error)}`, {
      style: "bold red",
    });
    return true;
  }
  const suggestion = suggestCommand(ui, result.command);
  const suffix = suggestion ? ` Did you mean ${suggestion}?` : "";
  session.publishNotice(`Unknown command: ${result.command}.${suffix}`);
  return true;
}

/** Keep accepting input while AgentSession executes in the background. */
export async function runSessionRepl(
  session: SessionReplSession,
  options: {
    commandHandler?: CommandHandler | undefined;
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
    ui: SessionUiLike;
  },
): Promise<boolean> {
  const { commandHandler, ui } = options;
  ui.startEventRenderer?.();
  ui.showWelcome?.();
  let cleanShutdown = false;
  try {
    for (;;) {
      let userInput: string;
      try {
        userInput = (await ui.prompt!()).trim();
      } catch (error) {
        if (isEofError(error)) {
          break;
        }
        if (isInterruptedError(error)) {
          session.publishNotice("Interrupted.", { style: "yellow" });
          continue;
        }
        throw error;
      }
      const keepGoing = await handleSessionInput(
        session,
        commandHandler,
        ui,
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
    ui.showError?.("Task worker did not stop before the shutdown timeout.");
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
    ui: SessionUiLike;
    runUi?: ((onSubmit: (text: string, options?: SubmitOptions) => void) => void | Promise<void>) | undefined;
  },
): Promise<boolean> {
  const { commandHandler, ui } = options;
  const runUi =
    options.runUi ??
    ((onSubmit: (text: string, options?: SubmitOptions) => void) => ui.run!(onSubmit));
  ui.showWelcome?.();
  const coordinator = startCoordinator(session, commandHandler, ui);
  let cleanShutdown = false;
  try {
    const enqueue = (userInput: string, submitOptions: SubmitOptions = {}): void => {
      // Exit is a local UI operation and should not wait behind a slow
      // semantic classification of an earlier queued message.
      if (userInput === "/exit") {
        void (async () => {
          try {
            await handleSessionInput(
              session,
              commandHandler,
              ui,
              userInput,
              submitOptions,
            );
          } catch (error) {
            try {
              session.publishNotice(`Error: ${errorMessage(error)}`, {
                style: "bold red",
              });
            } catch {
              // The event bus may already be closed during shutdown.
            }
          }
        })();
        ui.requestExit?.();
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
        ui.showError?.(shutdownMessage);
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
      const keepGoing = await handleSessionInput(session, commandHandler, null, userInput);
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

/**
 * The full input pipeline from terminal/editor.ts (buffer → negotiation
 * filter → raw decoder), mirroring PiInputSession. Replaces the Basic*
 * defaults of terminal/ui.ts inside the interactive loop.
 */
class ProductionInputDecoder implements InputDecoderLike {
  #stdinBuffer = new StdinBuffer();
  #filter: TerminalInputFilter;
  #decoder = new RawInputDecoder();

  constructor(hooks: InputDecoderHooks) {
    this.#filter = new TerminalInputFilter({
      enableModifyOtherKeys: () => {
        hooks.enableModifyOtherKeys();
      },
      disableModifyOtherKeys: () => {
        hooks.disableModifyOtherKeys();
      },
    });
  }

  get kittyProtocolActive(): boolean {
    return this.#filter.kittyProtocolActive;
  }

  set kittyProtocolActive(value: boolean) {
    this.#filter.kittyProtocolActive = value;
  }

  feed(data: Uint8Array): InputAction[] {
    const actions: InputAction[] = [];
    for (const event of this.#stdinBuffer.feed(data)) {
      if (event.kind === BufferedInputKind.Paste) {
        actions.push(
          inputAction(InputActionKind.Insert, event.data.toString("utf8")),
        );
        continue;
      }
      for (const sequence of this.#filter.feed(event.data)) {
        actions.push(...this.#decoder.feed(sequence));
      }
    }
    return actions;
  }

  flush(): InputAction[] {
    const actions: InputAction[] = [];
    for (const event of this.#stdinBuffer.flush()) {
      for (const sequence of this.#filter.feed(event.data)) {
        actions.push(...this.#decoder.feed(sequence));
      }
    }
    for (const sequence of this.#filter.flush()) {
      actions.push(...this.#decoder.feed(sequence));
    }
    actions.push(...this.#decoder.flush());
    return actions;
  }

  clear(): void {
    this.#stdinBuffer.clear();
    this.#filter.clear();
    // RawInputDecoder has no clear(); a fresh instance drops partial escapes.
    this.#decoder = new RawInputDecoder();
  }
}

/**
 * Wraps the production editor from terminal/editor.ts with the render result
 * shape terminal/ui.ts's EditorLike expects (cursorColumn → cursorCol).
 * Composition rather than inheritance: EditorState.renderLines has a
 * different, incompatible return type.
 */
class ProductionEditor implements EditorLike {
  readonly #state = new EditorState();

  get text(): string {
    return this.#state.text;
  }

  set text(value: string) {
    this.#state.text = value;
  }

  get cursor(): number {
    return this.#state.cursor;
  }

  set cursor(value: number) {
    this.#state.cursor = value;
  }

  get historyIndex(): number | null {
    return this.#state.historyIndex;
  }

  set historyIndex(value: number | null) {
    this.#state.historyIndex = value;
  }

  get completions(): readonly CompletionItemLike[] {
    return this.#state.completions;
  }

  get selectedCompletion(): number | null {
    return this.#state.selectedCompletion;
  }

  set selectedCompletion(value: number | null) {
    this.#state.selectedCompletion = value;
  }

  apply(
    action: InputAction,
    options: { runtimeActive: boolean },
  ): EditorEffect {
    return this.#state.apply(action, options);
  }

  setCompletions(values: readonly CompletionItemLike[]): void {
    this.#state.setCompletions(values);
  }

  renderLines(
    width: number,
    options: { prompt?: string; mask?: boolean } = {},
  ): EditorRenderResult {
    const rendered = this.#state.renderLines(width, options);
    return {
      lines: rendered.lines,
      cursorRow: rendered.cursorRow,
      cursorCol: rendered.cursorColumn,
    };
  }
}

/** Drive the interactive loop of a real TerminalUI with process stdin. */
async function runTerminalUi(
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export interface MainOptions {
  environ?: Record<string, string | undefined> | undefined;
  configPath?: string | undefined;
  credentialsPath?: string | undefined;
  inputFn?: InputFn | undefined;
  secretInputFn?: InputFn | undefined;
  outputFn?: OutputFn | undefined;
  clientFactory?: ((settings: ClientConnectionSettings) => unknown) | undefined;
  stdin?: { isTTY?: boolean | undefined } | undefined;
  stdout?: { isTTY?: boolean | undefined } | undefined;
}

export async function main(
  argv?: readonly string[] | null,
  options: MainOptions = {},
): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgs(argv ?? process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeStderr(USAGE);
      writeStderr(`laohuang: error: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`laohuang ${VERSION}\n`);
    return 0;
  }
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const args = parsed.args;
  const environ = options.environ ?? process.env;
  const projectRoot = process.cwd();
  // Instruction loading roots at the nearest .git ancestor; the tool
  // registry keeps the plain cwd as its root.
  const instructionRoot = findProjectRoot(process.cwd(), projectRoot);
  const interactive = supportsTerminalUI({
    inputFn: options.inputFn,
    outputFn: options.outputFn,
    stdin: options.stdin,
    stdout: options.stdout,
  });
  const inputFn = options.inputFn ?? defaultInputFn;
  const outputFn = options.outputFn ?? ((message) => console.log(message));
  const secretInputFn = options.secretInputFn ?? defaultSecretInputFn;

  const configPath = options.configPath ?? defaultConfigPath(environ);
  const manager = new ConfigManager(configPath);
  const credentials = new CredentialStore(
    options.credentialsPath ?? join(dirname(configPath), "credentials.json"),
  );
  // The selector's input/output targets are rewired once the session exists,
  // mirroring the Python original which mutated selector.input_fn/output_fn.
  // Like the Python original, the selector's own secret prompts (first-run
  // setup, `config` subcommand) always use the default secret reader — only
  // the session commands switch to the terminal UI's secret prompt.
  let selectorInput: PromptFn = async (prompt) => inputFn(prompt);
  const selectorSecretInput: PromptFn = async (prompt) => secretInputFn(prompt);
  let selectorOutput: OutputFn = outputFn;
  const selector = new ModelSelector({
    credentials,
    registry: { get: getProvider, names: providerNames },
    createClient,
    input: (prompt) => selectorInput(prompt),
    secretInput: (prompt) => selectorSecretInput(prompt),
    output: (message) => {
      selectorOutput(message);
    },
    clientFactory: options.clientFactory,
  });

  if (args.command === "config") {
    if (args.configAction === "list") {
      let profiles;
      try {
        profiles = manager.listProfiles();
      } catch (error) {
        writeStderr(`Configuration error: ${errorMessage(error)}`);
        return 2;
      }
      for (const profile of profiles) {
        const marker = profile.active ? "*" : " ";
        outputFn(
          `${marker} ${profile.name}  ${profile.provider}  ${profile.model}`,
        );
      }
      return 0;
    }

    if (args.configAction === "use") {
      if (!args.configTarget) {
        writeStderr("Configuration error: profile name is required");
        return 2;
      }
      try {
        manager.setActive(args.configTarget);
      } catch (error) {
        writeStderr(`Configuration error: ${errorMessage(error)}`);
        return 2;
      }
      outputFn(`Active profile: ${args.configTarget}`);
      return 0;
    }

    try {
      const selection = await selector.select({
        providerName: args.provider ?? undefined,
        modelName: args.configModel ?? undefined,
      });
      if (selection === null) {
        return 2;
      }
      manager.configure({
        name: args.configProfile,
        provider: selection.config.provider,
        model: selection.config.model,
        baseUrl: args.configBaseUrl ?? selection.config.baseUrl,
      });
    } catch (error) {
      writeStderr(`Configuration error: ${errorMessage(error)}`);
      return 2;
    }
    outputFn(`Saved profile '${args.configProfile}' to ${configPath}`);
    return 0;
  }

  if (args.command === "doctor") {
    let settings;
    try {
      settings = manager.resolveSettings({
        environ,
        profile: args.profile,
        model: args.model,
        baseUrl: args.baseUrl,
      });
    } catch (error) {
      writeStderr(`Configuration error: ${errorMessage(error)}`);
      return 2;
    }
    const keyConfigured = credentials.get(settings.provider) !== null;
    outputFn(`Provider: ${settings.provider}`);
    outputFn(`Model: ${settings.model}`);
    outputFn(`Base URL: ${settings.baseUrl ?? "SDK default"}`);
    outputFn(`API key: ${keyConfigured ? "configured" : "not configured"}`);
    outputFn(`Configuration: ${configPath}`);
    outputFn(`Node: ${process.version}`);
    outputFn(`Bash: ${existsSync("/bin/bash") ? "available" : "missing"}`);
    return keyConfigured ? 0 : 1;
  }

  let config: Config;
  let runtimeClient: unknown = null;
  try {
    if (existsSync(configPath)) {
      config = manager.resolve({
        credentials,
        environ,
        profile: args.profile,
        model: args.model,
        baseUrl: args.baseUrl,
      });
    } else {
      const selection = await selector.select();
      if (selection === null) {
        return 2;
      }
      config = {
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
        provider: selection.config.provider,
        profile: null,
        apiKey: selection.config.apiKey,
      };
      runtimeClient = selection.client;
      manager.configure({
        name: "default",
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
      });
      outputFn(`Configured ${config.provider} / ${config.model} as default.`);
    }
  } catch (error) {
    const message = errorMessage(error);
    if (existsSync(configPath) && message.startsWith("No API key configured")) {
      // A stored profile without its API key re-runs interactive selection
      // for the resolved provider/model (first-run setup flow).
      let selection;
      try {
        const settings = manager.resolveSettings({
          environ,
          profile: args.profile,
          model: args.model,
          baseUrl: args.baseUrl,
        });
        selection = await selector.select({
          providerName: settings.provider,
          modelName: settings.model,
        });
      } catch (selectionError) {
        writeStderr(`Configuration error: ${errorMessage(selectionError)}`);
        return 2;
      }
      if (selection === null) {
        return 2;
      }
      config = {
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
        provider: selection.config.provider,
        profile: null,
        apiKey: selection.config.apiKey,
      };
      runtimeClient = selection.client;
    } else {
      writeStderr(`Configuration error: ${message}`);
      return 2;
    }
  }

  const client =
    runtimeClient ??
    createClient(config, { clientFactory: options.clientFactory });

  let eventLog: EventLog | null = null;
  let dashboard: WebDashboard | null = null;
  if (args.web) {
    eventLog = new EventLog();
    eventLog.record("session_start", {
      project_root: projectRoot,
      provider: config.provider,
      model: config.model,
      profile: config.profile,
    });
    dashboard = new WebDashboard(eventLog, { port: args.webPort });
    try {
      await dashboard.start();
    } catch (error) {
      writeStderr(`Web dashboard error: ${errorMessage(error)}`);
      return 2;
    }
    if (!interactive) {
      outputFn(`Web dashboard: ${dashboard.url}`);
    }
  }

  // The interactive UI is constructed only once configuration (and the
  // dashboard URL) are known; its provider/model are read-only in TS.
  let terminalUi: TerminalUI | null = null;
  let terminalDriver: StdTerminalDriver | null = null;
  if (interactive) {
    terminalDriver = new StdTerminalDriver();
    terminalUi = new TerminalUI({
      projectRoot,
      provider: config.provider,
      model: config.model,
      dashboardUrl: dashboard?.url,
      theme: args.theme,
      driver: terminalDriver,
      editorFactory: () => new ProductionEditor(),
      decoderFactory: (hooks) => new ProductionInputDecoder(hooks),
    });
    terminalUi.state.provider = config.provider;
    terminalUi.state.model = config.model;
  }

  const agent = new CodingAgent({
    client: client as ChatClientLike,
    model: config.model,
    tools: new ToolRegistry(projectRoot),
    provider: config.provider,
    projectRoot: instructionRoot,
    startupCwd: process.cwd(),
  });
  const semanticClassifier = new SmallModelSemanticClassifier({
    client: client as unknown as ChatCompletionsClient,
    model: config.model,
  });
  // session.ts asserts at compile time that CodingAgent satisfies its
  // AgentRunnerLike contract (run(userInput, TaskContext)), so the agent can
  // be handed to the session directly — no adapter needed.
  let commandDispatcher: CommandHandler | undefined;
  const runtime = new AgentSession(agent, {
    semanticClassifier,
    commandDispatcher: (command) =>
      commandDispatcher?.(command) ?? { status: "not_found", command },
  });
  const plainSink = terminalUi === null ? new PlainEventSink(outputFn) : null;
  const sessionSink: TerminalUI | PlainEventSink = terminalUi ?? plainSink!;

  let replInputFn: InputFn = inputFn;
  let commandsSecretInput: PromptFn = selectorSecretInput;
  if (plainSink !== null) {
    const underlyingInput = inputFn;
    const underlyingSecretInput = secretInputFn;
    // Setup/command prompts go through the event pipeline in plain mode so
    // they interleave with task output. The Python original also flushed the
    // bus here; TS delivery is microtask-driven and catches up at the next
    // await.
    const plainInput = async (prompt: string): Promise<string> => {
      if (prompt) {
        runtime.publishNotice(prompt);
      }
      return underlyingInput("");
    };
    const plainSecretInput = async (prompt: string): Promise<string> => {
      if (prompt) {
        runtime.publishNotice(prompt);
      }
      return underlyingSecretInput("");
    };
    replInputFn = plainInput;
    selectorInput = plainInput;
    commandsSecretInput = plainSecretInput;
  } else if (terminalUi !== null) {
    // /login and interactive /model run while the terminal loop owns stdin in
    // raw mode: their questions must be asked through the UI loop, not read
    // from fd 0 directly.
    const prompts = terminalUiPrompts(terminalUi);
    selectorInput = prompts.input;
    commandsSecretInput = prompts.secretInput;
  }
  selectorOutput = (message) => {
    runtime.publishNotice(message);
  };
  const sessionOutput = (message: string): void => {
    runtime.publishNotice(message);
  };

  const commands = new SessionCommands({
    agent,
    selector,
    credentials,
    currentConfig: {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
    },
    input: (prompt) => selectorInput(prompt),
    secretInput: (prompt) => commandsSecretInput(prompt),
    output: sessionOutput,
    session: runtime,
  });

  const unsubscribers: Array<() => void> = [];
  const projector = new EventProjector();
  unsubscribers.push(
    runtime.eventBus.subscribe((event) => {
      sessionSink.publishEvent(projector.project(event, "terminal"));
    }),
  );
  if (eventLog !== null) {
    // The dashboard feeds from the canonical pull buffer; the promise
    // resolves when the bus closes. Unexpected failures are dropped the same
    // way the Python daemon thread lost them.
    void consumePullBuffer(runtime.eventBus, eventLog).catch(() => {});
  }

  if (terminalUi !== null) {
    terminalUi.setCommandRegistry(commands.registry);
    terminalUi.setCancelCallback(() => {
      const action = routeHumanIntent(
        makeCancelIntent("keyboard", "editor"),
        runtime.state,
      );
      void runtime.submitAction(action);
    });
    terminalUi.setKeyActionCallback((action) => {
      if (action === "select_model") {
        void commandDispatcher?.("/model");
        return;
      }
      if (action === "clear_screen") {
        void commandDispatcher?.("/clear");
        return;
      }
      runtime.publishNotice(`Key action is unavailable: ${action}.`);
    });
    terminalUi.setRuntimeRunningCallback(() => runtime.activeTask !== null);
  }

  const handleCommand: CommandHandler = async (command) => {
    const result = await commands.execute(command);
    semanticClassifier.configure({
      client: agent.client as unknown as ChatCompletionsClient,
      model: agent.model,
    });
    return result;
  };
  commandDispatcher = handleCommand;

  let cleanShutdown = false;
  try {
    if (terminalUi !== null && terminalDriver !== null) {
      const ui = terminalUi;
      const driver = terminalDriver;
      cleanShutdown = await runSessionRepl(runtime, {
        commandHandler: handleCommand,
        ui,
        runUi: (enqueue) => runTerminalUi(ui, driver, enqueue),
      });
    } else {
      cleanShutdown = await runPlainSessionRepl(runtime, {
        commandHandler: handleCommand,
        inputFn: replInputFn,
        sink: plainSink!,
      });
    }
  } finally {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    if (dashboard !== null) {
      await dashboard.stop();
    }
  }
  return cleanShutdown ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Direct execution (dist/cli.js is the npm bin entry)
// ---------------------------------------------------------------------------

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      writeStderr(`laohuang: ${errorMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
