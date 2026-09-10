import { inputTimeout, drainTerminalInput } from "./terminal-session.ts";
import { truncateToWidth } from "./terminal-text.ts";
import { TerminalInputDecoder } from "./terminal-input-decoder.ts";
import { MainScreenRenderer, type ScreenFrame } from "./screen.ts";
/**
 * One-shot raw-mode prompt used before a raw session starts (setup questions).
 *
 * TypeScript replacement for terminal_input.py's prompt_toolkit Application:
 * the same framed editor (border, wrapped input, completion menu, footer) is
 * rendered by hand on top of the decoding pipeline from terminal/editor.ts —
 * no prompt_toolkit, no Ink, stdin raw mode via node:tty semantics.
 */

import type { Readable, Writable } from "node:stream";
import { enterTerminalRawMode, type RawModeInput } from "./native-console.ts";

import {
  EditorState,
  InputActionKind,
  inputAction,
  toTuiInputEvent,
  type CompletionItem,
  type InputAction,
} from "./editor.ts";
import { DEFAULT_KEYBINDINGS } from "../keybindings/default-keybindings.ts";
import { KeybindingsManager } from "../keybindings/keybindings.ts";

export { toTuiInputEvent } from "./editor.ts";
export type { TuiInputEvent } from "../keybindings/key-id.ts";

/** Raised when the user aborts the prompt with Ctrl+C (mirrors KeyboardInterrupt). */
export class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

/** Raised on Ctrl+D with an empty editor (mirrors EOFError). */
export class PromptEofError extends Error {
  constructor() {
    super("Prompt aborted with EOF");
    this.name = "PromptEofError";
  }
}

export type PromptInput = Readable & RawModeInput;
export type PromptOutput = Writable & { readonly columns?: number; readonly rows?: number };

export interface TerminalInputSessionOptions {
  /**
   * Accepted for PromptSession API compatibility. The Python implementation
   * stores the message but its layout never renders it; kept for parity.
   */
  message?: string;
  multiline?: boolean;
  /** Preloaded history entries; submitted lines are appended in place. */
  history?: string[];
  /** Slash-command completion source, re-queried whenever the text changes. */
  completer?: (text: string) => CompletionItem[];
  /** Maximum completion menu rows. */
  reserveSpaceForMenu?: number;
  /** Erase the whole frame once the prompt finishes (Python default: true). */
  eraseWhenDone?: boolean;
  /** Mask input with `*` (replaces PromptSession's is_password). */
  mask?: boolean;
  footer?: () => string;
  input?: PromptInput;
  output?: PromptOutput;
}

const PROMPT = "❯ ";
const SETUP_PROMPT_KEYBINDINGS = new KeybindingsManager(DEFAULT_KEYBINDINGS);

function resolveSetupPromptAction(action: InputAction): InputAction {
  if (action.kind !== InputActionKind.Key) {
    return action;
  }
  const event = toTuiInputEvent(action);
  if (event.type !== "key") {
    return action;
  }
  const binding = SETUP_PROMPT_KEYBINDINGS.resolve(event.key, ["editor"]);
  if (binding === "cancel") {
    return inputAction(InputActionKind.Cancel);
  }
  if (binding === "editor_newline" || binding === "submit_follow_up") {
    return inputAction(InputActionKind.Newline);
  }
  if (binding === "dismiss") {
    return inputAction(InputActionKind.Dismiss);
  }
  return action;
}

/** Compact PromptSession-compatible editor for setup questions only. */
export class TerminalInputSession {
  private readonly multiline: boolean;
  private readonly sharedHistory: string[] | null;
  private readonly completer: ((text: string) => CompletionItem[]) | null;
  private readonly reserveSpaceForMenu: number;
  private readonly eraseWhenDone: boolean;
  private readonly mask: boolean;
  private readonly footer: (() => string) | null;
  private readonly input: PromptInput;
  private readonly output: PromptOutput;

  private history: string[] = [];

  constructor(options: TerminalInputSessionOptions = {}) {
    this.multiline = options.multiline ?? true;
    this.sharedHistory = options.history ?? null;
    this.completer = options.completer ?? null;
    this.reserveSpaceForMenu = options.reserveSpaceForMenu ?? 6;
    this.eraseWhenDone = options.eraseWhenDone ?? true;
    this.mask = options.mask ?? false;
    this.footer = options.footer ?? null;
    this.input = options.input ?? (process.stdin as PromptInput);
    this.output = options.output ?? (process.stdout as PromptOutput);
    this.history = [...(options.history ?? [])];
  }

  prompt(): Promise<string> {
    const editor = new EditorState();
    editor.history = [...this.history];
    const input = this.input;
    const output = this.output;
    let modifyOtherKeys = false;
    const decoder = new TerminalInputDecoder({
      enableModifyOtherKeys: () => { output.write("\x1b[>4;2m"); modifyOtherKeys = true; },
      disableModifyOtherKeys: () => { if (modifyOtherKeys) output.write("\x1b[>4;0m"); modifyOtherKeys = false; },
    });

    let lastFrame: ScreenFrame = { lines: [], activeStart: 0, cursorRow: 0, cursorCol: 0 };
    let lastCompletedText: string | null = null;
    let settled = false;
    let flushTimer: NodeJS.Timeout | null = null;
    let restoreRawMode: (() => void) | null = null;
    let pasteEnabled = false;

    const termWidth = (): number =>
      typeof output.columns === "number" && output.columns > 0
        ? output.columns
        : 80;
    const renderer = new MainScreenRenderer({
      write: text => { output.write(text); },
      flush() {},
      getSize: () => ({ columns: termWidth(), rows: Math.max(1, output.rows ?? 24) }),
      restore() {}, // This prompt owns raw mode and restores it after input drain.
    });

    const refreshCompletions = (): void => {
      if (this.completer === null || editor.text === lastCompletedText) {
        return;
      }
      lastCompletedText = editor.text;
      editor.setCompletions(this.completer(editor.text));
    };

    const buildFrame = (): { lines: string[]; cursorRow: number; cursorColumn: number } => {
      const width = termWidth();
      const rendered = editor.renderLines(width, { prompt: PROMPT, mask: this.mask });
      const border = "─".repeat(Math.max(1, width));
      const lines = [border, ...rendered.lines, border];
      if (editor.completionVisible) {
        for (const [index, item] of editor.completions
          .slice(0, this.reserveSpaceForMenu)
          .entries()) {
          const row = truncateToWidth(` ${item.value}  ${item.description}`, width);
          lines.push(
            index === editor.selectedCompletion
              ? `\x1b[7m${row}\x1b[27m`
              : row,
          );
        }
      }
      if (this.footer !== null) {
        for (const row of this.footer().split("\n").slice(0, 2)) {
          lines.push(truncateToWidth(row, width));
        }
      }
      return {
        lines,
        cursorRow: 1 + rendered.cursorRow,
        cursorColumn: rendered.cursorColumn,
      };
    };

    const redraw = (): void => {
      const frame = buildFrame();
      lastFrame = { lines: frame.lines, activeStart: 0, cursorRow: frame.cursorRow, cursorCol: frame.cursorColumn };
      renderer.render(lastFrame);
    };

    return new Promise<string>((resolve, reject) => {
      const finish = (
        error: Error | null,
        result: string,
        recordHistory = true,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        output.removeListener("resize", onResize);
        void (async () => {
          try {
            try {
              if (pasteEnabled) output.write("\x1b[?2004l\x1b[<u" + (modifyOtherKeys ? "\x1b[>4;0m" : ""));
            } finally {
              await drainTerminalInput(input);
            }
            renderer.render(this.eraseWhenDone
              ? { lines: [], activeStart: 0, cursorRow: 0, cursorCol: 0 }
              : { ...lastFrame, cursorRow: Math.max(0, lastFrame.lines.length - 1), cursorCol: 0 });
          } catch (cleanupError) {
            error = error ?? (cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
          } finally {
            try { renderer.close(); }
            finally {
              input.removeListener("error", onError);
              restoreRawMode?.();
              decoder.clear();
            }
          }
          output.write(this.eraseWhenDone ? "\r\x1b[0J" : "\r\n");
          if (error !== null) {
            this.persistHistory(editor);
            reject(error);
            return;
          }
          if (result && recordHistory) editor.history = [...editor.history, result];
          this.persistHistory(editor);
          resolve(result);
        })().catch(reject);
      };

      const handleAction = (action: InputAction): void => {
        if (settled) {
          return;
        }
        const resolvedAction = resolveSetupPromptAction(action);
        if (resolvedAction.kind === InputActionKind.Cancel) {
          finish(new PromptCancelledError(), "");
          return;
        }
        if (resolvedAction.kind === InputActionKind.Eof) {
          if (!editor.text) {
            finish(new PromptEofError(), "");
          }
          return;
        }
        if (resolvedAction.kind === InputActionKind.Submit) {
          refreshCompletions();
          if (editor.completionVisible) {
            const effect = editor.apply(resolvedAction, { runtimeActive: false });
            refreshCompletions();
            if (effect.submit !== null) {
              // Slash commands accept and submit in one Enter (pi semantics);
              // editor.submit() already recorded the history entry.
              finish(null, effect.submit, false);
            }
          } else {
            finish(null, editor.text);
          }
          return;
        }
        if (resolvedAction.kind === InputActionKind.Newline && !this.multiline) {
          return;
        }
        editor.apply(resolvedAction, { runtimeActive: false });
        refreshCompletions();
      };

      const scheduleEscapeFlush = (): void => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
        }
        const timeout = inputTimeout(decoder.pendingKind());
        if (timeout === null) { flushTimer = null; return; }
        flushTimer = setTimeout(() => {
          flushTimer = null;
          try {
            for (const action of decoder.flush()) handleAction(action);
            refreshCompletions();
            if (!settled) redraw();
          } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
        }, timeout);
        flushTimer.unref();
      };

      const onData = (chunk: Buffer): void => {
        try {
          for (const action of decoder.feed(chunk)) handleAction(action);
          if (settled) return;
          refreshCompletions();
          redraw();
          scheduleEscapeFlush();
        } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
      };

      const onEnd = (): void => finish(new PromptEofError(), "");
      const onError = (error: Error): void => finish(error, "");
      const onResize = (): void => {
        if (settled) return;
        try { redraw(); } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
      };
      try {
        restoreRawMode = enterTerminalRawMode(input);
        pasteEnabled = true;
        output.write("\x1b[?2004h\x1b[>7u\x1b[?u\x1b[c");
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("error", onError);
        output.on("resize", onResize);
        refreshCompletions();
        redraw();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)), "");
      }
    });
  }

  private persistHistory(editor: EditorState): void {
    this.history = [...editor.history];
    if (this.sharedHistory !== null) {
      this.sharedHistory.length = 0;
      this.sharedHistory.push(...editor.history);
    }
  }
}
