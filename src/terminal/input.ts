/**
 * One-shot raw-mode prompt used before a raw session starts (setup questions).
 *
 * TypeScript replacement for terminal_input.py's prompt_toolkit Application:
 * the same framed editor (border, wrapped input, completion menu, footer) is
 * rendered by hand on top of the decoding pipeline from terminal/editor.ts —
 * no prompt_toolkit, no Ink, stdin raw mode via node:tty semantics.
 */

import type { Readable, Writable } from "node:stream";

import {
  BufferedInputKind,
  EditorState,
  InputActionKind,
  RawInputDecoder,
  StdinBuffer,
  TerminalInputFilter,
  charCellWidth,
  inputAction,
  type CompletionItem,
  type InputAction,
} from "./editor.ts";

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

export type PromptInput = Readable & { setRawMode?: (mode: boolean) => void };
export type PromptOutput = Writable & { readonly columns?: number };

export interface PiInputSessionOptions {
  /**
   * Accepted for PromptSession API compatibility. The Python PiInputSession
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
/** Delay before a buffered standalone Escape resolves into a dismissal. */
const ESCAPE_FLUSH_MS = 25;

/** Compact PromptSession-compatible editor for setup questions only. */
export class PiInputSession {
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

  constructor(options: PiInputSessionOptions = {}) {
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
    const stdinBuffer = new StdinBuffer();
    const inputFilter = new TerminalInputFilter();
    const decoder = new RawInputDecoder();
    const input = this.input;
    const output = this.output;

    let frameHeight = 0;
    let frameCursorRow = 0;
    let lastCompletedText: string | null = null;
    let settled = false;
    let flushTimer: NodeJS.Timeout | null = null;

    const termWidth = (): number =>
      typeof output.columns === "number" && output.columns > 0
        ? output.columns
        : 80;

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
      let chunk = "";
      if (frameHeight > 0) {
        if (frameHeight > 1) {
          chunk += `\x1b[${frameHeight - 1}A`;
        }
        chunk += "\r\x1b[0J";
      }
      chunk += frame.lines.join("\r\n");
      const up = frame.lines.length - 1 - frame.cursorRow;
      if (up > 0) {
        chunk += `\x1b[${up}A`;
      }
      chunk += "\r";
      if (frame.cursorColumn > 0) {
        chunk += `\x1b[${frame.cursorColumn}C`;
      }
      output.write(chunk);
      frameHeight = frame.lines.length;
      frameCursorRow = frame.cursorRow;
    };

    return new Promise<string>((resolve, reject) => {
      const finish = (error: Error | null, result: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        input.removeListener("data", onData);
        if (typeof input.setRawMode === "function") {
          input.setRawMode(false);
        }
        if (this.eraseWhenDone) {
          let chunk = "";
          if (frameHeight > 1) {
            chunk += `\x1b[${frameHeight - 1}A`;
          }
          chunk += "\r\x1b[0J";
          output.write(chunk);
        } else {
          let chunk = "";
          const down = frameHeight - 1 - frameCursorRow;
          if (down > 0) {
            chunk += `\x1b[${down}B`;
          }
          chunk += "\r\n";
          output.write(chunk);
        }
        if (error !== null) {
          this.persistHistory(editor);
          reject(error);
          return;
        }
        if (result) {
          editor.history = [...editor.history, result];
        }
        this.persistHistory(editor);
        resolve(result);
      };

      const handleAction = (action: InputAction): void => {
        if (settled) {
          return;
        }
        if (action.kind === InputActionKind.Cancel) {
          finish(new PromptCancelledError(), "");
          return;
        }
        if (action.kind === InputActionKind.Eof) {
          if (!editor.text) {
            finish(new PromptEofError(), "");
          }
          return;
        }
        if (action.kind === InputActionKind.Submit) {
          refreshCompletions();
          if (editor.completionVisible) {
            editor.apply(action, { runtimeActive: false });
            refreshCompletions();
          } else {
            finish(null, editor.text);
          }
          return;
        }
        if (action.kind === InputActionKind.Newline && !this.multiline) {
          return;
        }
        editor.apply(action, { runtimeActive: false });
        refreshCompletions();
      };

      const scheduleEscapeFlush = (): void => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
        }
        flushTimer = setTimeout(() => {
          flushTimer = null;
          for (const event of stdinBuffer.flush()) {
            for (const sequence of inputFilter.feed(event.data)) {
              for (const action of decoder.feed(sequence)) {
                handleAction(action);
              }
            }
          }
          for (const sequence of inputFilter.flush()) {
            for (const action of decoder.feed(sequence)) {
              handleAction(action);
            }
          }
          for (const action of decoder.flush()) {
            handleAction(action);
          }
          refreshCompletions();
          if (!settled) {
            redraw();
          }
        }, ESCAPE_FLUSH_MS);
        flushTimer.unref();
      };

      const onData = (chunk: Buffer): void => {
        for (const event of stdinBuffer.feed(chunk)) {
          if (event.kind === BufferedInputKind.Paste) {
            handleAction(
              inputAction(InputActionKind.Insert, event.data.toString("utf8")),
            );
            continue;
          }
          for (const sequence of inputFilter.feed(event.data)) {
            for (const action of decoder.feed(sequence)) {
              handleAction(action);
            }
          }
        }
        if (settled) {
          return;
        }
        refreshCompletions();
        redraw();
        scheduleEscapeFlush();
      };

      if (typeof input.setRawMode === "function") {
        input.setRawMode(true);
      }
      input.on("data", onData);
      refreshCompletions();
      redraw();
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

function truncateToWidth(text: string, width: number): string {
  let result = "";
  let used = 0;
  for (const char of text) {
    const charWidth = Math.max(1, charCellWidth(char));
    if (used + charWidth > width) {
      break;
    }
    result += char;
    used += charWidth;
  }
  return result;
}
