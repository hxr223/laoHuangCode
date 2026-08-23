/**
 * Polished interactive terminal UI for laoHuangCode.
 *
 * Port of terminal_ui.py: the sole terminal writer. Everything visible is an
 * append-only transcript of blocks; mutable blocks stream inline and are
 * frozen (never rewritten) once their turn completes. Cancelled/truncated
 * partial replies stay on screen and are marked.
 *
 * Scope notes for the TypeScript rewrite:
 * - The legacy prompt_toolkit/rich console path has no TS equivalent; the
 *   interactive UI is always the single-renderer raw loop, and non-TTY
 *   sessions use PlainEventSink.
 * - The editor and raw-input decoder behind the loop live behind the
 *   EditorLike/InputDecoderLike interfaces so terminal/input.ts (another
 *   workstream) can be injected once landed. BasicEditorState and
 *   BasicInputDecoder are the built-in defaults implementing that contract.
 */

import { appendFileSync } from "node:fs";

export { toTuiInputEvent } from "./editor.ts";
export type { TuiInputEvent } from "../keybindings/key-id.ts";

import {
  ACTION_CAPABILITIES,
  DEFAULT_RUNTIME_CAPABILITIES,
  unavailableActionNotice,
  type RuntimeCapabilities,
} from "../capabilities.ts";
import { DEFAULT_KEYBINDINGS } from "../keybindings/default-keybindings.ts";
import { makeKeyInput, type KeyInput, type TuiInputEvent } from "../keybindings/key-id.ts";
import {
  KeybindingsManager,
  type ActionId,
  type KeybindingOverrides,
} from "../keybindings/keybindings.ts";
import {
  createUIState,
  UIEventReducer,
  type UIEventLike,
  type UIState,
} from "../ui-state.ts";
import {
  DisplayPolicy,
  displayGapMessage,
  type DisplayEvent,
  type DisplayEventLike,
} from "../ui/display-policy.ts";
import type { DisplayAction } from "../ui/display-actions.ts";
import {
  TranscriptStore,
  createTranscriptBlock,
  type TranscriptBlock,
} from "../ui/transcript-store.ts";
import { FrameBuilder } from "../ui/frame-builder.ts";
import { renderMarkdownLines } from "./markdown.ts";
import { resolveTerminalTheme, type TerminalTheme } from "./theme.ts";
import {
  PiMainScreenRenderer,
  charCellWidth,
  truncateToWidth,
  visibleWidth,
  wrapTextToWidth,
  type ScreenFrame,
  type TerminalDriver,
} from "./screen.ts";

// ---------------------------------------------------------------------------
// Shared input contracts (implemented by terminal/input.ts once landed)
// ---------------------------------------------------------------------------

export type InputActionKind =
  | "insert"
  | "submit"
  | "newline"
  | "complete"
  | "history_up"
  | "history_down"
  | "cursor_left"
  | "cursor_right"
  | "backspace"
  | "key"
  | "dismiss"
  | "cancel"
  | "eof";

export interface InputAction {
  kind: InputActionKind;
  text?: string;
  key?: KeyInput;
}

export interface EditorEffect {
  submit?: string | null;
  cancelRequested?: boolean;
  exitRequested?: boolean;
  notice?: string | null;
}

/** A completion independent of any particular input widget. */
export interface CompletionItemLike {
  value: string;
  description: string;
  start: number;
}

export interface EditorRenderResult {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

/** The editor surface the interactive loop renders and drives. */
export interface EditorLike {
  text: string;
  cursor: number;
  historyIndex: number | null;
  readonly completions: readonly CompletionItemLike[];
  selectedCompletion: number | null;
  apply(action: InputAction, options: { runtimeActive: boolean }): EditorEffect;
  setCompletions(values: readonly CompletionItemLike[]): void;
  renderLines(
    width: number,
    options: { prompt?: string; mask?: boolean },
  ): EditorRenderResult;
}

/** Hooks the input decoder uses to negotiate terminal keyboard modes. */
export interface InputDecoderHooks {
  enableModifyOtherKeys(): void;
  disableModifyOtherKeys(): void;
}

/** Bytes-to-actions input pipeline used by the interactive loop. */
export interface InputDecoderLike {
  kittyProtocolActive: boolean;
  feed(data: Uint8Array): InputAction[];
  flush(): InputAction[];
  clear(): void;
}

export type EditorFactory = () => EditorLike;
export type InputDecoderFactory = (hooks: InputDecoderHooks) => InputDecoderLike;

/** Slash-command completion source (commands.ts once landed). */
export interface CommandRegistryLike {
  complete(text: string, options: { state: string }): CompletionItemLike[];
}

// ---------------------------------------------------------------------------
// BasicEditorState — default line editor behind the raw loop
// ---------------------------------------------------------------------------

function cpSlice(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join("");
}

function cpLength(text: string): number {
  return [...text].length;
}

function cellWidth(char: string): number {
  return Math.max(1, charCellWidth(char));
}

function textDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += cellWidth(char);
  }
  return width;
}

function wrapEditorLine(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  for (const char of text) {
    const charWidth = cellWidth(char);
    if (row && rowWidth + charWidth > width) {
      rows.push(row);
      row = "";
      rowWidth = 0;
    }
    row += char;
    rowWidth += charWidth;
  }
  if (row || rows.length === 0) {
    rows.push(row);
  }
  return rows;
}

function editorCursorPosition(text: string, width: number): [number, number] {
  let row = 0;
  let column = 0;
  for (const char of text) {
    const charWidth = cellWidth(char);
    if (column > 0 && column + charWidth > width) {
      row += 1;
      column = 0;
    }
    column += charWidth;
    if (column === width) {
      row += 1;
      column = 0;
    }
  }
  return [row, column];
}

/**
 * Text, history, and command-completion state for the active editor.
 *
 * Default implementation of EditorLike; the richer editor from
 * terminal/input.ts can replace it through the same interface.
 */
export class BasicEditorState implements EditorLike {
  text = "";
  /** Cursor position in code points. */
  cursor = 0;
  history: string[] = [];
  historyIndex: number | null = null;
  #historyDraft = "";
  completions: CompletionItemLike[] = [];
  selectedCompletion: number | null = null;

  get completionVisible(): boolean {
    return this.completions.length > 0;
  }

  setCompletions(values: readonly CompletionItemLike[]): void {
    this.completions = this.text.startsWith("/") ? [...values] : [];
    this.selectedCompletion = this.completions.length > 0 ? 0 : null;
  }

  apply(action: InputAction, options: { runtimeActive: boolean }): EditorEffect {
    if (action.kind === "submit") {
      if (this.completionVisible) {
        this.#acceptCompletion();
        return {};
      }
      return this.#submit();
    }
    if (action.kind === "newline") {
      this.#insert("\n");
      return {};
    }
    if (action.kind === "cancel") {
      return this.#cancelOrClear(options.runtimeActive);
    }
    if (action.kind === "eof") {
      return this.#exitOrNotice(options.runtimeActive);
    }
    if (action.kind === "dismiss") {
      this.#clearCompletions();
      return {};
    }
    return this.#applyEditAction(action);
  }

  renderLines(
    width: number,
    options: { prompt?: string; mask?: boolean } = {},
  ): EditorRenderResult {
    const prompt = options.prompt ?? "❯ ";
    const mask = options.mask ?? false;
    const targetWidth = Math.max(3, width);
    const promptWidth = Math.max(1, textDisplayWidth(prompt));
    const contentWidth = Math.max(1, targetWidth - promptWidth);
    const displayText = mask ? "*".repeat(cpLength(this.text)) : this.text;
    const sourceLines = displayText.split("\n");
    const rows: string[] = [];
    for (const source of sourceLines) {
      rows.push(...wrapEditorLine(source, contentWidth));
    }
    const lastSource = sourceLines[sourceLines.length - 1] as string;
    if (
      displayText &&
      !displayText.endsWith("\n") &&
      textDisplayWidth(lastSource) % contentWidth === 0
    ) {
      rows.push("");
    }
    const rendered = rows.map(
      (row, index) => (index === 0 ? prompt : " ".repeat(promptWidth)) + row,
    );
    const before = cpSlice(displayText, 0, this.cursor);
    const beforeLines = before.split("\n");
    let priorRows = 0;
    for (const line of beforeLines.slice(0, -1)) {
      priorRows += wrapEditorLine(line, contentWidth).length;
    }
    const current = beforeLines[beforeLines.length - 1] as string;
    const [currentRow, currentColumn] = editorCursorPosition(current, contentWidth);
    const cursorRow = priorRows + currentRow;
    const cursorColumn = promptWidth + currentColumn;
    return {
      lines: rendered,
      cursorRow: Math.min(cursorRow, rendered.length - 1),
      cursorCol: Math.min(cursorColumn, targetWidth - 1),
    };
  }

  #submit(): EditorEffect {
    const submitted = this.text;
    this.#clearCompletions();
    this.text = "";
    this.cursor = 0;
    this.historyIndex = null;
    this.#historyDraft = "";
    if (!submitted) {
      return {};
    }
    this.history = [...this.history, submitted];
    return { submit: submitted };
  }

  #cancelOrClear(runtimeActive: boolean): EditorEffect {
    if (runtimeActive) {
      return { cancelRequested: true };
    }
    this.text = "";
    this.cursor = 0;
    this.historyIndex = null;
    this.#clearCompletions();
    return {};
  }

  #exitOrNotice(runtimeActive: boolean): EditorEffect {
    if (runtimeActive) {
      return { notice: "A task is still running. Press Ctrl+C to cancel it." };
    }
    if (this.text) {
      return { notice: "Clear the editor before exiting." };
    }
    return { exitRequested: true };
  }

  #applyEditAction(action: InputAction): EditorEffect {
    if (action.kind === "history_up" && this.completionVisible) {
      this.#moveCompletion(-1);
    } else if (action.kind === "history_down" && this.completionVisible) {
      this.#moveCompletion(1);
    } else if (action.kind === "insert") {
      this.#insert(action.text ?? "");
    } else if (action.kind === "backspace" && this.cursor > 0) {
      this.#clearCompletions();
      this.text = cpSlice(this.text, 0, this.cursor - 1) + cpSlice(this.text, this.cursor);
      this.cursor -= 1;
    } else if (action.kind === "cursor_left") {
      this.#clearCompletions();
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (action.kind === "cursor_right") {
      this.#clearCompletions();
      this.cursor = Math.min(cpLength(this.text), this.cursor + 1);
    } else if (action.kind === "history_up") {
      this.#historyUp();
    } else if (action.kind === "history_down") {
      this.#historyDown();
    } else if (action.kind === "complete") {
      this.#acceptCompletion();
    }
    this.#closeCompletionIfContextLost();
    return {};
  }

  #insert(text: string): void {
    this.#clearCompletions();
    this.text = cpSlice(this.text, 0, this.cursor) + text + cpSlice(this.text, this.cursor);
    this.cursor += cpLength(text);
    this.historyIndex = null;
  }

  #acceptCompletion(): void {
    if (this.selectedCompletion === null) {
      return;
    }
    const item = this.completions[this.selectedCompletion] as CompletionItemLike;
    const start = Math.max(0, this.cursor + item.start);
    this.text = cpSlice(this.text, 0, start) + item.value + cpSlice(this.text, this.cursor);
    this.cursor = start + cpLength(item.value);
    this.#clearCompletions();
  }

  #moveCompletion(offset: number): void {
    if (this.selectedCompletion === null) {
      return;
    }
    const count = this.completions.length;
    this.selectedCompletion = (((this.selectedCompletion + offset) % count) + count) % count;
  }

  #historyUp(): void {
    if (this.history.length === 0) {
      return;
    }
    if (this.historyIndex === null) {
      this.#historyDraft = this.text;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }
    this.text = this.history[this.historyIndex] as string;
    this.cursor = cpLength(this.text);
  }

  #historyDown(): void {
    if (this.historyIndex === null) {
      return;
    }
    if (this.historyIndex === this.history.length - 1) {
      this.text = this.#historyDraft;
      this.historyIndex = null;
    } else {
      this.historyIndex += 1;
      this.text = this.history[this.historyIndex] as string;
    }
    this.cursor = cpLength(this.text);
  }

  #closeCompletionIfContextLost(): void {
    if (!this.text.startsWith("/")) {
      this.#clearCompletions();
    }
  }

  #clearCompletions(): void {
    this.completions = [];
    this.selectedCompletion = null;
  }
}

// ---------------------------------------------------------------------------
// BasicInputDecoder — default bytes-to-actions pipeline
// ---------------------------------------------------------------------------

const ESC = 0x1b;
const PASTE_START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]; // \x1b[200~
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]; // \x1b[201~

const CSI_ARROW_ACTIONS: Record<string, InputActionKind> = {
  "\x1b[A": "history_up",
  "\x1b[B": "history_down",
  "\x1b[C": "cursor_right",
  "\x1b[D": "cursor_left",
  "\x1bOA": "history_up",
  "\x1bOB": "history_down",
  "\x1bOC": "cursor_right",
  "\x1bOD": "cursor_left",
};

const CONTROL_ACTIONS: Record<number, InputActionKind> = {
  3: "cancel",
  4: "eof",
  9: "complete",
  8: "backspace",
  127: "backspace",
};

const CONTROL_KEYS: Readonly<Record<number, KeyInput>> = {
  12: makeKeyInput("ctrl_l", { ctrl: true }),
  15: makeKeyInput("character", { text: "o", ctrl: true }),
  20: makeKeyInput("character", { text: "t", ctrl: true }),
};

const SPECIAL_ESCAPE_ACTIONS: Record<string, InputActionKind> = {
  "\x1b[13;2u": "newline",
  "\x1b[57414;2u": "newline",
  "\x1b[13u": "submit",
  "\x1b[13;1u": "submit",
  "\x1b[57414u": "submit",
  "\x1b[57414;1u": "submit",
  "\x1b[9u": "complete",
  "\x1b[9;1u": "complete",
  "\x1b[127u": "backspace",
  "\x1b[127;1u": "backspace",
  "\x1b[27u": "dismiss",
  "\x1b[27;1u": "dismiss",
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function findSubsequence(haystack: number[], needle: number[]): number {
  outer: for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

/** Split a byte run into complete UTF-8 content and an incomplete tail. */
function splitIncompleteUtf8(bytes: number[]): [number[], number[]] {
  let index = bytes.length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 4 && ((bytes[index] as number) & 0xc0) === 0x80) {
    index -= 1;
    continuation += 1;
  }
  if (index < 0) {
    return [bytes, []];
  }
  const lead = bytes[index] as number;
  const needed =
    lead < 0x80 ? 1 : lead >= 0xc0 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf7 ? 4 : 1;
  if (bytes.length - index < needed) {
    return [bytes.slice(0, index), bytes.slice(index)];
  }
  return [bytes, []];
}

function decodeUtf8(bytes: number[]): string {
  return utf8Decoder.decode(new Uint8Array(bytes));
}

export interface BasicInputDecoderOptions {
  isAppleTerminal?: () => boolean;
  shiftPressed?: () => boolean;
}

/**
 * Incremental raw-input decoder with bracketed-paste and keyboard-mode
 * negotiation handling. Default InputDecoderLike; the input workstream's
 * pipeline can replace it through the same interface.
 */
export class BasicInputDecoder implements InputDecoderLike {
  #hooks: InputDecoderHooks;
  #isAppleTerminal: () => boolean;
  #shiftPressed: () => boolean;
  #buffer: number[] = [];
  #pasteMode = false;
  #pasteBuffer: number[] = [];
  kittyProtocolActive = false;

  constructor(hooks: InputDecoderHooks, options: BasicInputDecoderOptions = {}) {
    this.#hooks = hooks;
    this.#isAppleTerminal = options.isAppleTerminal ?? (() => false);
    this.#shiftPressed = options.shiftPressed ?? (() => false);
  }

  feed(data: Uint8Array): InputAction[] {
    if (data.length === 0) {
      return [];
    }
    let bytes = [...data];
    if (bytes.length === 1 && (bytes[0] as number) > 127) {
      bytes = [ESC, (bytes[0] as number) - 128];
    }
    this.#buffer.push(...bytes);
    return this.#process();
  }

  flush(): InputAction[] {
    if (this.#pasteMode || this.#buffer.length === 0) {
      return [];
    }
    const buffered = this.#buffer;
    this.#buffer = [];
    if (buffered.length === 1 && buffered[0] === ESC) {
      return [{ kind: "dismiss" }];
    }
    if (buffered[0] === ESC && buffered[1] === 0x5b) {
      // A split CSI sequence stays buffered; a genuine one is dropped.
      return [];
    }
    const [actions] = this.#decodeSequences(buffered);
    return actions;
  }

  clear(): void {
    this.#buffer = [];
    this.#pasteBuffer = [];
    this.#pasteMode = false;
  }

  #process(): InputAction[] {
    const actions: InputAction[] = [];
    for (;;) {
      if (this.#pasteMode) {
        this.#pasteBuffer.push(...this.#buffer);
        this.#buffer = [];
        const end = findSubsequence(this.#pasteBuffer, PASTE_END);
        if (end === -1) {
          return actions;
        }
        const pasted = this.#pasteBuffer.slice(0, end);
        const remaining = this.#pasteBuffer.slice(end + PASTE_END.length);
        this.#pasteBuffer = [];
        this.#pasteMode = false;
        actions.push({ kind: "insert", text: decodeUtf8(pasted) });
        this.#buffer = [...remaining, ...this.#buffer];
        continue;
      }
      const start = findSubsequence(this.#buffer, PASTE_START);
      if (start !== -1) {
        const before = this.#buffer.slice(0, start);
        const after = this.#buffer.slice(start + PASTE_START.length);
        const [sequenceActions] = this.#decodeSequences(before);
        actions.push(...sequenceActions);
        this.#buffer = [];
        this.#pasteMode = true;
        this.#pasteBuffer = after;
        continue;
      }
      const [sequenceActions, remainder] = this.#decodeSequences(this.#buffer);
      actions.push(...sequenceActions);
      this.#buffer = remainder;
      return actions;
    }
  }

  #decodeSequences(bytes: number[]): [InputAction[], number[]] {
    const actions: InputAction[] = [];
    let index = 0;
    while (index < bytes.length) {
      const byte = bytes[index] as number;
      if (byte === ESC) {
        const parsed = this.#parseEscape(bytes, index);
        if (parsed === null) {
          break;
        }
        index = parsed.next;
        if (parsed.action !== undefined) {
          actions.push(parsed.action);
        }
        continue;
      }
      if (byte === 10 || byte === 13) {
        index += 1;
        if (byte === 13 && this.#isAppleTerminal() && this.#shiftPressed()) {
          actions.push({ kind: "newline" });
        } else {
          actions.push({ kind: "submit" });
        }
        continue;
      }
      const key = CONTROL_KEYS[byte];
      if (key !== undefined) {
        index += 1;
        actions.push({ kind: "key", key });
        continue;
      }
      const control = CONTROL_ACTIONS[byte];
      if (control !== undefined) {
        index += 1;
        actions.push({ kind: control });
        continue;
      }
      if (byte < 32) {
        index += 1;
        continue;
      }
      let end = index;
      while (end < bytes.length && (bytes[end] as number) >= 32 && bytes[end] !== 127) {
        end += 1;
      }
      const [complete, tail] = splitIncompleteUtf8(bytes.slice(index, end));
      if (complete.length > 0) {
        actions.push({ kind: "insert", text: decodeUtf8(complete) });
      }
      index = end - tail.length;
      if (tail.length > 0) {
        break;
      }
    }
    return [actions, bytes.slice(index)];
  }

  #parseEscape(
    bytes: number[],
    start: number,
  ): { next: number; action?: InputAction } | null {
    if (start + 1 >= bytes.length) {
      return null;
    }
    const second = bytes[start + 1] as number;
    if (second === 10 || second === 13) {
      return { next: start + 2, action: { kind: "newline" } };
    }
    if (second === 0x5b) {
      let final = -1;
      for (let index = start + 2; index < bytes.length; index += 1) {
        const code = bytes[index] as number;
        if (code >= 0x40 && code <= 0x7e) {
          final = index;
          break;
        }
      }
      if (final === -1) {
        return null;
      }
      const sequence = String.fromCharCode(...bytes.slice(start, final + 1));
      const action = this.#classifyCsi(sequence);
      return action === undefined
        ? { next: final + 1 }
        : { next: final + 1, action };
    }
    if (second === 0x4f) {
      if (start + 2 >= bytes.length) {
        return null;
      }
      const sequence = String.fromCharCode(...bytes.slice(start, start + 3));
      const kind = CSI_ARROW_ACTIONS[sequence];
      return kind === undefined
        ? { next: start + 3 }
        : { next: start + 3, action: { kind } };
    }
    // An unsupported Alt sequence has no editor meaning; retain its character.
    return { next: start + 1 };
  }

  #classifyCsi(sequence: string): InputAction | undefined {
    const kittyFlags = /^\x1b\[\?(\d+)u$/.exec(sequence);
    if (kittyFlags !== null) {
      if (Number.parseInt(kittyFlags[1] as string, 10)) {
        this.#hooks.disableModifyOtherKeys();
        this.kittyProtocolActive = true;
      } else {
        this.#hooks.enableModifyOtherKeys();
      }
      return undefined;
    }
    if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
      if (!this.kittyProtocolActive) {
        this.#hooks.enableModifyOtherKeys();
      }
      return undefined;
    }
    if (sequence.startsWith("\x1b[?")) {
      // Other negotiation responses (or their abandoned tails) are swallowed.
      return undefined;
    }
    if (sequence === "\x1b[Z") {
      return { kind: "key", key: makeKeyInput("tab", { shift: true }) };
    }
    const special = SPECIAL_ESCAPE_ACTIONS[sequence];
    if (special !== undefined) {
      return { kind: special };
    }
    const arrow = CSI_ARROW_ACTIONS[sequence];
    if (arrow !== undefined) {
      return { kind: arrow };
    }
    if (this.#isKittyRelease(sequence)) {
      return undefined;
    }
    const kittyPrintable =
      /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/.exec(sequence);
    if (kittyPrintable !== null) {
      const codepoint = Number.parseInt(kittyPrintable[1] as string, 10);
      const shifted = kittyPrintable[2]
        ? Number.parseInt(kittyPrintable[2], 10)
        : null;
      const modifier = Number.parseInt(kittyPrintable[4] ?? "1", 10) - 1;
      const lockMask = 64 + 128;
      if (modifier & ~(1 | lockMask)) {
        return undefined;
      }
      if (modifier & (2 | 4)) {
        return undefined;
      }
      const effective = modifier & 1 && shifted !== null ? shifted : codepoint;
      if (effective < 32) {
        return undefined;
      }
      try {
        return { kind: "insert", text: String.fromCodePoint(effective) };
      } catch {
        return undefined;
      }
    }
    const modifyOtherKeys = /^\x1b\[27;(\d+);(\d+)~$/.exec(sequence);
    if (modifyOtherKeys !== null) {
      const modifier = Number.parseInt(modifyOtherKeys[1] as string, 10) - 1;
      if (modifier & ~1) {
        return undefined;
      }
      const codepoint = Number.parseInt(modifyOtherKeys[2] as string, 10);
      if (codepoint < 32) {
        return undefined;
      }
      try {
        return { kind: "insert", text: String.fromCodePoint(codepoint) };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  #isKittyRelease(sequence: string): boolean {
    if (sequence.includes("\x1b[200~")) {
      return false;
    }
    return [":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F"].some((marker) =>
      sequence.includes(marker),
    );
  }
}

export { createTranscriptBlock, type TranscriptBlock } from "../ui/transcript-store.ts";

/** Local command feedback sharing the loop's event queue. */
class LocalMessage {
  readonly text: string;
  readonly style: string;

  constructor(text: string, style = "") {
    this.text = text;
    this.style = style;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

// ---------------------------------------------------------------------------
// ANSI style helpers (rich-style "italic #rrggbb" / "bg:#rrggbb" strings)
// ---------------------------------------------------------------------------

const NAMED_COLOR_CODES: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
};

function hexToRgb(value: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    return null;
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function ansiCodes(style: string): string[] {
  const codes: string[] = [];
  let nextColorIsBackground = false;
  for (const token of style.replace(/bg:/g, " bg:").split(/\s+/).filter(Boolean)) {
    if (token === "bold") {
      codes.push("1");
    } else if (token === "dim") {
      codes.push("2");
    } else if (token === "italic") {
      codes.push("3");
    } else if (token === "underline") {
      codes.push("4");
    } else if (token === "on") {
      nextColorIsBackground = true;
    } else if (token.startsWith("bg:#") && token.length === 10) {
      const rgb = hexToRgb(token.slice(3));
      if (rgb !== null) {
        codes.push(`48;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
      }
    } else if (token.startsWith("#") && token.length === 7) {
      const rgb = hexToRgb(token);
      if (rgb !== null) {
        const prefix = nextColorIsBackground ? "48" : "38";
        codes.push(`${prefix};2;${rgb[0]};${rgb[1]};${rgb[2]}`);
      }
      nextColorIsBackground = false;
    } else if (token in NAMED_COLOR_CODES) {
      let code = NAMED_COLOR_CODES[token] as string;
      if (nextColorIsBackground) {
        code = String(Number.parseInt(code, 10) + 10);
      }
      codes.push(code);
      nextColorIsBackground = false;
    } else {
      nextColorIsBackground = false;
    }
  }
  return codes;
}

function ansiStyledText(style: string, text: string): string {
  if (!style || !text) {
    return text;
  }
  const codes = ansiCodes(style);
  if (codes.length === 0) {
    return text;
  }
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// InteractiveTerminalLoop — serialize stdin, UI events, and terminal writes
// ---------------------------------------------------------------------------

interface LoopQuestion {
  message: string;
  secret: boolean;
  resolve(answer: string): void;
}

type LoopWorkItem =
  | { type: "input"; data: Uint8Array }
  | { type: "event"; event: unknown };

/** Minimal readable-source contract for the production run loop. */
export interface LoopInputSource {
  on(event: "data", listener: (data: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  off?(event: "data" | "end", listener: (...args: never[]) => void): unknown;
  /** Stop flowing mode so the handle no longer keeps the event loop alive. */
  pause?(): unknown;
}

/** A terminal driver that may support raw-mode entry (POSIX TTY). */
export type RawTerminalDriver = TerminalDriver & { enterRawMode?: () => void };

function inputEventFromAction(action: InputAction): TuiInputEvent {
  if (action.kind === "insert") {
    return { type: "text", text: action.text ?? "" };
  }
  if (action.kind === "key") {
    if (action.key === undefined) {
      throw new Error("key input action is missing its key");
    }
    return { type: "key", key: action.key };
  }
  const key = action.kind === "submit" ? makeKeyInput("enter")
    : action.kind === "newline" ? makeKeyInput("enter", { alt: true })
    : action.kind === "complete" ? makeKeyInput("tab")
    : action.kind === "history_up" ? makeKeyInput("up")
    : action.kind === "history_down" ? makeKeyInput("down")
    : action.kind === "cursor_left" ? makeKeyInput("left")
    : action.kind === "cursor_right" ? makeKeyInput("right")
    : action.kind === "backspace" ? makeKeyInput("backspace")
    : action.kind === "dismiss" ? makeKeyInput("escape")
    : action.kind === "cancel" ? makeKeyInput("ctrl_c", { ctrl: true })
    : makeKeyInput("ctrl_d", { ctrl: true });
  return { type: "key", key };
}

function editorActionForKey(key: KeyInput): InputAction | null {
  if (key.id === "enter") return { kind: "submit" };
  if (key.id === "tab") return { kind: "complete" };
  if (key.id === "up") return { kind: "history_up" };
  if (key.id === "down") return { kind: "history_down" };
  if (key.id === "left") return { kind: "cursor_left" };
  if (key.id === "right") return { kind: "cursor_right" };
  if (key.id === "backspace") return { kind: "backspace" };
  if (key.id === "ctrl_d") return { kind: "eof" };
  return null;
}

/** Serialize stdin, UI events, and all terminal writes in one loop. */
export class InteractiveTerminalLoop {
  static readonly ESCAPE_TIMEOUT_MS = 50;
  static readonly WORK_QUEUE_LIMIT = 4_096;

  #ui: TerminalUI;
  #driver: RawTerminalDriver;
  #work: LoopWorkItem[] = [];
  #editor: EditorLike;
  #decoder: InputDecoderLike;
  #renderer: PiMainScreenRenderer;
  #onSubmit: (text: string) => void = () => {};
  #exitRequested = false;
  #closed = false;
  #running = false;
  #question: LoopQuestion | null = null;
  #needsRender = true;
  #terminalModesStarted = false;
  #keyboardProtocolPushed = false;
  #modifyOtherKeysActive = false;
  #exitResolve: (() => void) | null = null;
  #escapeTimer: ReturnType<typeof setTimeout> | null = null;
  #wakeupEnabled = false;
  #wakeupScheduled = false;
  writeError: unknown = null;

  constructor(
    ui: TerminalUI,
    driver: RawTerminalDriver,
    editor: EditorLike,
    decoderFactory: InputDecoderFactory,
  ) {
    this.#ui = ui;
    this.#driver = driver;
    this.#editor = editor;
    this.#decoder = decoderFactory({
      enableModifyOtherKeys: () => {
        this.#enableModifyOtherKeys();
      },
      disableModifyOtherKeys: () => {
        this.#disableModifyOtherKeys();
      },
    });
    this.#renderer = new PiMainScreenRenderer(driver);
  }

  get editor(): EditorLike {
    return this.#editor;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get running(): boolean {
    return this.#running;
  }

  start(onSubmit: (text: string) => void): void {
    this.#onSubmit = onSubmit;
    this.#exitRequested = false;
    this.#running = true;
  }

  publishEvent(event: unknown): void {
    if (this.#closed) {
      return;
    }
    if (!this.#ui.shouldQueueDisplayEvent(event)) {
      return;
    }
    if (
      this.#work.length >= InteractiveTerminalLoop.WORK_QUEUE_LIMIT - 128 &&
      this.#ui.isHighFrequencyDisplayEvent(event)
    ) {
      this.#ui.recordDisplayDrop(event);
      return;
    }
    this.#work.push({ type: "event", event: this.#ui.withDisplayDropMarker(event) });
    this.#scheduleWakeup();
  }

  feedInputBytes(data: Uint8Array): void {
    if (this.#closed) {
      return;
    }
    this.#work.push({ type: "input", data });
    this.#scheduleWakeup();
  }

  /** Synchronously consume queued work; this is also the test hook. */
  drain(): void {
    const changed = this.#drainWork();
    const dropped = this.#ui.flushDisplayDropMarker();
    if (changed || dropped || this.#needsRender) {
      this.#render();
    }
  }

  requestRender(): void {
    this.#needsRender = true;
    this.#scheduleWakeup();
  }

  ask(message: string, options: { secret?: boolean } = {}): Promise<string> {
    if (this.#closed || !this.#running) {
      return Promise.resolve("");
    }
    const secret = options.secret ?? false;
    return new Promise<string>((resolve) => {
      this.#question = { message, secret, resolve };
      this.#resetEditor();
      this.#needsRender = true;
      this.#scheduleWakeup();
    });
  }

  requestExit(): void {
    this.#exitRequested = true;
    this.#exitResolve?.();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#running = false;
    const question = this.#question;
    this.#question = null;
    question?.resolve("");
    if (this.#escapeTimer !== null) {
      clearTimeout(this.#escapeTimer);
      this.#escapeTimer = null;
    }
    this.#stopTerminalModes();
    try {
      this.#renderer.close();
    } catch (error) {
      if (this.writeError === null) {
        this.writeError = error;
      }
    }
  }

  /** Production entry: raw mode, terminal modes, stdin-driven draining. */
  async run(input?: LoopInputSource): Promise<void> {
    try {
      this.#driver.enterRawMode?.();
      this.startTerminalModes();
      const onData = (data: Uint8Array): void => {
        this.feedInputBytes(data);
        this.drain();
        this.#armEscapeTimer();
      };
      const onEnd = (): void => {
        this.#applyActions(this.#decoder.flush());
        // Port of terminal_ui.py: EOF applies the editor's exit effect —
        // exit only when the editor is idle and empty; otherwise the editor
        // notice ("Clear the editor before exiting.") is shown and the loop
        // keeps running.
        this.#applyEof();
        this.drain();
      };
      input?.on("data", onData);
      input?.on("end", onEnd);
      this.#wakeupEnabled = true;
      try {
        if (!this.#exitRequested) {
          await new Promise<void>((resolve) => {
            this.#exitResolve = resolve;
          });
        }
      } finally {
        this.#wakeupEnabled = false;
        input?.off?.("data", onData);
        input?.off?.("end", onEnd);
        // Pause stdin: a still-flowing stdin keeps the event loop alive and
        // the process would never exit after the UI closed. Raw mode is
        // restored by the renderer close path.
        input?.pause?.();
      }
    } catch (error) {
      this.writeError = error;
    } finally {
      if (this.#escapeTimer !== null) {
        clearTimeout(this.#escapeTimer);
        this.#escapeTimer = null;
      }
      this.close();
    }
  }

  startTerminalModes(): void {
    if (this.#terminalModesStarted) {
      return;
    }
    this.#terminalModesStarted = true;
    this.#driver.write("\x1b[?2004h");
    this.#keyboardProtocolPushed = true;
    this.#driver.write("\x1b[>7u\x1b[?u\x1b[c");
    this.#driver.flush();
  }

  #stopTerminalModes(): void {
    if (!this.#terminalModesStarted) {
      return;
    }
    this.#terminalModesStarted = false;
    try {
      this.#driver.write("\x1b[?2004l");
      if (this.#keyboardProtocolPushed || this.#decoder.kittyProtocolActive) {
        this.#driver.write("\x1b[<u");
        this.#keyboardProtocolPushed = false;
        this.#decoder.kittyProtocolActive = false;
      }
      this.#disableModifyOtherKeys();
      this.#driver.flush();
    } finally {
      this.#decoder.clear();
    }
  }

  #enableModifyOtherKeys(): void {
    if (this.#decoder.kittyProtocolActive || this.#modifyOtherKeysActive) {
      return;
    }
    this.#driver.write("\x1b[>4;2m");
    this.#modifyOtherKeysActive = true;
  }

  #disableModifyOtherKeys(): void {
    if (!this.#modifyOtherKeysActive) {
      return;
    }
    this.#driver.write("\x1b[>4;0m");
    this.#modifyOtherKeysActive = false;
  }

  #armEscapeTimer(): void {
    if (this.#escapeTimer !== null) {
      clearTimeout(this.#escapeTimer);
    }
    this.#escapeTimer = setTimeout(() => {
      this.#escapeTimer = null;
      this.#applyActions(this.#decoder.flush());
      this.drain();
    }, InteractiveTerminalLoop.ESCAPE_TIMEOUT_MS);
  }

  /**
   * Production wakeup: while run() is active, queued work is rendered on the
   * next event-loop turn — the role of the Python selector loop's wakeup
   * pipe. Outside run(), drain() stays the synchronous test hook and nothing
   * is scheduled.
   */
  #scheduleWakeup(): void {
    if (!this.#wakeupEnabled || this.#wakeupScheduled || this.#closed) {
      return;
    }
    this.#wakeupScheduled = true;
    setImmediate(() => {
      this.#wakeupScheduled = false;
      this.drain();
    });
  }

  #drainWork(): boolean {
    let changed = false;
    let item = this.#work.shift();
    while (item !== undefined) {
      if (item.type === "input") {
        this.#applyActions(this.#decoder.feed(item.data));
        changed = true;
      } else if (item.event instanceof LocalMessage) {
        const message = item.event;
        this.#ui.appendTranscript(
          createTranscriptBlock("notice", this.#ui.newBlockId(), {
            text: message.text,
            style: message.style,
          }),
        );
      } else {
        this.#ui.applyProjectedEvent(item.event as UIEventLike);
        changed = true;
      }
      item = this.#work.shift();
    }
    return changed;
  }

  #render(): void {
    this.#needsRender = false;
    try {
      const question = this.#question;
      this.#renderer.render(
        this.#ui.buildFrame({
          width: Math.max(1, this.#driver.getSize().columns),
          editor: this.#editor,
          prompt: question !== null ? `${question.message} ` : "❯ ",
          secret: question !== null && question.secret,
        }),
      );
    } catch (error) {
      this.writeError = error;
      this.requestExit();
    }
  }

  #applyActions(actions: readonly InputAction[]): void {
    for (const action of actions) {
      this.#applyInputEvent(inputEventFromAction(action));
    }
  }

  #applyInputEvent(event: TuiInputEvent): void {
    if (event.type === "text" || event.type === "paste") {
      this.#applyEditorAction({ kind: "insert", text: event.text });
      return;
    }
    const action = this.#ui.keybindings.resolve(event.key, ["terminal", "editor"]);
    if (action !== null) {
      this.#applyKeyAction(action);
      return;
    }
    const editorAction = editorActionForKey(event.key);
    if (editorAction !== null) {
      this.#applyEditorAction(editorAction);
    }
  }

  #applyKeyAction(action: ActionId): void {
    const capability = ACTION_CAPABILITIES[action as keyof typeof ACTION_CAPABILITIES];
    if (capability !== undefined && !this.#ui.capabilities[capability]) {
      this.#appendNotice(unavailableActionNotice(action as keyof typeof ACTION_CAPABILITIES));
      this.#needsRender = true;
      return;
    }
    if (action === "editor_newline") {
      this.#applyEditorAction({ kind: "newline" });
    } else if (action === "dismiss") {
      this.#applyEditorAction({ kind: "dismiss" });
    } else if (action === "cancel") {
      this.#applyEditorAction({ kind: "cancel" });
    } else if (action === "toggle_tool_output") {
      this.#ui.toggleToolOutputFromKeybinding();
      this.#needsRender = true;
    } else {
      this.#ui.handleKeyAction(action);
      this.#needsRender = true;
    }
  }

  #applyEditorAction(action: InputAction): void {
    if (this.#applyQuestionAction(action)) {
      this.#needsRender = true;
      return;
    }
    const effect = this.#editor.apply(action, {
      runtimeActive: this.#ui.isRunning(),
    });
    this.#applyEffect(effect);
    this.#refreshCompletions();
    this.#needsRender = true;
  }

  #applyEof(): void {
    const effect = this.#editor.apply(
      { kind: "eof" },
      { runtimeActive: this.#ui.isRunning() },
    );
    this.#applyEffect(effect);
    this.#needsRender = true;
  }

  #applyEffect(effect: EditorEffect): void {
    if (effect.submit !== null && effect.submit !== undefined) {
      this.#ui.acceptUserInput(effect.submit);
      this.#onSubmit(effect.submit);
    }
    if (effect.cancelRequested) {
      this.#ui.cancelFromKeybinding();
    }
    if (effect.notice) {
      this.#appendNotice(effect.notice);
    }
    if (effect.exitRequested) {
      this.requestExit();
    }
  }

  #applyQuestionAction(action: InputAction): boolean {
    const question = this.#question;
    if (question === null) {
      return false;
    }
    if (action.kind === "submit") {
      const answer = this.#editor.text;
      if (this.#question === question) {
        this.#question = null;
      }
      this.#resetEditor();
      question.resolve(answer);
      return true;
    }
    if (action.kind === "cancel" || action.kind === "eof") {
      if (this.#question === question) {
        this.#question = null;
      }
      this.#resetEditor();
      question.resolve("");
      return true;
    }
    const effect = this.#editor.apply(action, { runtimeActive: false });
    if (effect.notice) {
      this.#appendNotice(effect.notice);
    }
    return true;
  }

  #appendNotice(text: string): void {
    this.#ui.appendTranscript(
      createTranscriptBlock("notice", this.#ui.newBlockId(), {
        text,
        style: "yellow",
      }),
    );
  }

  #resetEditor(): void {
    this.#editor.text = "";
    this.#editor.cursor = 0;
    this.#editor.historyIndex = null;
    this.#editor.setCompletions([]);
  }

  #refreshCompletions(): void {
    if (this.#question !== null) {
      this.#editor.setCompletions([]);
      return;
    }
    const registry = this.#ui.commandRegistry;
    if (registry !== null) {
      this.#editor.setCompletions(
        registry.complete(this.#editor.text, {
          state: this.#ui.isRunning() ? "RUNNING_MODEL" : this.#ui.state.sessionState,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TerminalUI
// ---------------------------------------------------------------------------

/** A terminal driver that may also expose raw-mode entry. */
export interface TerminalUIOptions {
  /** Plain-text fallback writer used when no live loop owns the screen. */
  output?: (text: string) => void;
  projectRoot?: string;
  provider?: string;
  model?: string;
  dashboardUrl?: string;
  commandRegistry?: CommandRegistryLike | null;
  cancelCallback?: ((command: string) => void) | null;
  theme?: string | null;
  driver?: RawTerminalDriver | null;
  editorFactory?: EditorFactory;
  decoderFactory?: InputDecoderFactory;
  /** Non-loop prompt fallback (setup questions outside a live session). */
  askFallback?: (message: string, secret: boolean) => Promise<string>;
  capabilities?: Partial<RuntimeCapabilities>;
  keybindingOverrides?: KeybindingOverrides;
  keyActionCallback?: (action: Exclude<ActionId, "editor_newline" | "dismiss" | "cancel">) => void;
}

/**
 * Width used when the real terminal width cannot be determined — the same
 * default Rich's Console falls back to on an unknown-size terminal.
 */
const FALLBACK_MARKDOWN_WIDTH = 80;

/**
 * Best-effort terminal width for the plain (loop-less) fallback writer, so
 * markdown output wraps at the real terminal width instead of being
 * hard-wrapped mid-word by the terminal itself.
 */
function resolveFallbackMarkdownWidth(): number {
  const columns = process.stdout?.columns;
  return typeof columns === "number" && columns > 0 ? columns : FALLBACK_MARKDOWN_WIDTH;
}

/**
 * Render interactive agent sessions with the append-only transcript model.
 *
 * With a terminal driver, all painting goes through the raw interactive
 * loop; without one the UI is a headless transcript plus a plain fallback
 * writer (non-interactive sessions should prefer PlainEventSink).
 */
export class TerminalUI {
  readonly theme: TerminalTheme;
  readonly state: UIState;
  readonly reducer: UIEventReducer;

  commandRegistry: CommandRegistryLike | null;
  cancelCallback: ((command: string) => void) | null;
  runtimeRunningCallback: (() => boolean) | null = null;

  readonly projectRoot: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly dashboardUrl: string | null;
  readonly capabilities: RuntimeCapabilities;
  readonly keybindings: KeybindingsManager;

  #output: (text: string) => void;
  #askFallback: ((message: string, secret: boolean) => Promise<string>) | null;
  #loop: InteractiveTerminalLoop | null = null;
  readonly #transcript: TranscriptStore;
  readonly #displayPolicy = new DisplayPolicy({
    audience: "terminal",
    foldToolOutput: false,
  });
  readonly #frameBuilder: FrameBuilder;
  #pendingDisplayDrops = 0;
  #keyActionCallback: ((action: Exclude<ActionId, "editor_newline" | "dismiss" | "cancel">) => void) | null;

  constructor(options: TerminalUIOptions = {}) {
    this.theme = resolveTerminalTheme(options.theme);
    this.projectRoot = options.projectRoot ?? null;
    this.provider = options.provider ?? null;
    this.model = options.model ?? null;
    this.dashboardUrl = options.dashboardUrl ?? null;
    this.capabilities = { ...DEFAULT_RUNTIME_CAPABILITIES, ...options.capabilities };
    this.keybindings = new KeybindingsManager(
      DEFAULT_KEYBINDINGS,
      options.keybindingOverrides,
    );
    this.commandRegistry = options.commandRegistry ?? null;
    this.cancelCallback = options.cancelCallback ?? null;
    this.#output = options.output ?? ((text) => console.log(text));
    this.#askFallback = options.askFallback ?? null;
    this.#keyActionCallback = options.keyActionCallback ?? null;
    this.state = createUIState();
    this.state.provider = options.provider ?? "";
    this.state.model = options.model ?? "";
    this.reducer = new UIEventReducer(this.state);
    this.#transcript = new TranscriptStore({
      errorStyle: `bold ${this.theme.color("error")}`,
    });
    this.#frameBuilder = new FrameBuilder({
      state: this.state,
      transcript: this.#transcript,
      projectRoot: this.projectRoot,
      provider: this.provider,
      model: this.model,
    });
    if (options.driver) {
      const editorFactory = options.editorFactory ?? (() => new BasicEditorState());
      const decoderFactory =
        options.decoderFactory ?? ((hooks) => new BasicInputDecoder(hooks));
      this.#loop = new InteractiveTerminalLoop(
        this,
        options.driver,
        editorFactory(),
        decoderFactory,
      );
    }
  }

  get interactiveLoop(): InteractiveTerminalLoop | null {
    return this.#loop;
  }

  get renderError(): unknown {
    return this.#loop?.writeError ?? null;
  }

  // -- prompts ------------------------------------------------------------

  prompt(message?: string): Promise<string> {
    if (this.#loop !== null && this.#loop.running) {
      return this.#loop.ask(message ?? "Input:");
    }
    if (this.#askFallback !== null) {
      return this.#askFallback(message ?? "", false);
    }
    return Promise.reject(
      new Error("interactive prompt requires a running terminal loop"),
    );
  }

  promptSecret(message: string): Promise<string> {
    if (this.#loop !== null && this.#loop.running) {
      return this.#loop.ask(message, { secret: true });
    }
    if (this.#askFallback !== null) {
      return this.#askFallback(message, true);
    }
    return Promise.reject(
      new Error("interactive prompt requires a running terminal loop"),
    );
  }

  // -- loop lifecycle -----------------------------------------------------

  /** Run the single-owner interactive terminal for the whole session. */
  async run(onSubmit: (text: string) => void): Promise<void> {
    if (this.#loop === null) {
      throw new Error("single-renderer mode is unavailable for this UI");
    }
    this.#loop.start(onSubmit);
    await this.#loop.run();
  }

  requestExit(): void {
    this.#loop?.requestExit();
  }

  close(): void {
    this.#loop?.close();
  }

  startLoop(onSubmit: (text: string) => void): void {
    if (this.#loop === null) {
      throw new Error("a terminal driver is required");
    }
    this.#loop.start(onSubmit);
    this.#loop.startTerminalModes();
  }

  feedInputBytes(data: Uint8Array): void {
    if (this.#loop === null) {
      throw new Error("a terminal driver is required");
    }
    this.#loop.feedInputBytes(data);
  }

  drainLoop(): void {
    this.#loop?.drain();
  }

  flushEventRenderer(): void {
    this.#loop?.drain();
  }

  // -- callbacks ----------------------------------------------------------

  setCommandRegistry(registry: CommandRegistryLike): void {
    this.commandRegistry = registry;
  }

  setCancelCallback(callback: (command: string) => void): void {
    this.cancelCallback = callback;
  }

  setRuntimeRunningCallback(callback: () => boolean): void {
    this.runtimeRunningCallback = callback;
  }

  handleKeyAction(action: Exclude<ActionId, "editor_newline" | "dismiss" | "cancel">): void {
    this.#keyActionCallback?.(action);
  }

  toggleToolOutputFromKeybinding(): void {
    this.applyDisplayAction({
      type: "toggle_tool_output",
      expanded: !this.#transcript.toolOutputExpanded(),
    });
  }

  isRunning(): boolean {
    if (this.runtimeRunningCallback !== null) {
      return Boolean(this.runtimeRunningCallback());
    }
    return ["RUNNING_MODEL", "RUNNING_TOOL", "RUNNING_TOOLS", "CANCELLING"].includes(
      this.state.sessionState,
    );
  }

  shouldQueueDisplayEvent(event: unknown): boolean {
    if (!isRecord(event) || !("kind" in event)) {
      return true;
    }
    return this.#displayPolicy.shouldQueue({
      kind: event.kind,
      payload: event.payload,
      correlation_id: event.correlation_id,
    });
  }

  isHighFrequencyDisplayEvent(event: unknown): boolean {
    if (!isRecord(event) || !("kind" in event)) {
      return false;
    }
    return this.#displayPolicy.isHighFrequency({
      kind: event.kind,
      payload: event.payload,
      correlation_id: event.correlation_id,
    });
  }

  recordDisplayDrop(event: unknown): void {
    if (!isRecord(event) || !("kind" in event)) {
      this.#pendingDisplayDrops += 1;
      return;
    }
    this.#pendingDisplayDrops += 1 + this.#displayPolicy.droppedCount({
      kind: event.kind,
      payload: event.payload,
      correlation_id: event.correlation_id,
    });
  }

  withDisplayDropMarker(event: unknown): unknown {
    if (this.#pendingDisplayDrops === 0 || !isRecord(event) || !("kind" in event)) {
      return event;
    }
    const pending = this.#pendingDisplayDrops;
    this.#pendingDisplayDrops = 0;
    const payload = isRecord(event.payload) ? event.payload : {};
    const inherited = this.#displayPolicy.droppedCount({
      kind: event.kind,
      payload,
      correlation_id: event.correlation_id,
    });
    return {
      ...event,
      payload: { ...payload, _projection_dropped: inherited + pending },
    };
  }

  flushDisplayDropMarker(): boolean {
    if (this.#pendingDisplayDrops === 0) {
      return false;
    }
    const dropped = this.#pendingDisplayDrops;
    this.#pendingDisplayDrops = 0;
    this.appendTranscript(createTranscriptBlock("notice", this.newBlockId(), {
      text: displayGapMessage(dropped),
      style: "yellow",
    }));
    return true;
  }

  cancelFromKeybinding(): void {
    if (this.state.sessionState === "CANCELLING") {
      this.write("Cancelling…");
      return;
    }
    this.cancelCallback?.("/cancel");
  }

  // -- transcript ---------------------------------------------------------

  newBlockId(): string {
    return this.#transcript.newBlockId();
  }

  appendTranscript(block: TranscriptBlock): void {
    this.#transcript.append(block);
  }

  acceptUserInput(text: string): void {
    this.appendTranscript(createTranscriptBlock("user", this.newBlockId(), { text }));
  }

  blockFor(kind: string, key: string): TranscriptBlock {
    return this.#transcript.blockFor(kind, key);
  }

  /** Build every persisted transcript line; never crop history here. */
  buildHistoryLines(width: number): string[] {
    return this.#buildHistoryFrameParts(width).lines;
  }

  #buildHistoryFrameParts(width: number): { lines: string[]; activeStart: number | null } {
    const usableWidth = Math.max(12, width);
    const blocks = this.#transcript.blocks();
    const lines: string[] = [];
    let activeStart: number | null = null;
    for (const block of blocks) {
      if (block.mutable && activeStart === null) {
        activeStart = lines.length;
      }
      if (block.kind === "assistant") {
        lines.push(...renderMarkdownLines(block.text, usableWidth, this.theme));
      } else {
        for (const [style, text] of this.#renderTranscriptItem(block, usableWidth)) {
          lines.push(ansiStyledText(style, text.replace(/\n+$/u, "")));
        }
      }
    }
    return { lines, activeStart };
  }

  buildFrame(options: {
    width: number;
    editor: EditorLike;
    prompt?: string;
    secret?: boolean;
  }): ScreenFrame {
    const { width, editor } = options;
    const { lines: history, activeStart } = this.#buildHistoryFrameParts(width);
    const completion = this.#completionLines(width, editor);
    return this.#frameBuilder.build({
      ...options,
      historyLines: history,
      activeStart,
      completionLines: completion,
    }).screen;
  }

  #completionLines(width: number, editor: EditorLike): string[] {
    const rows: string[] = [];
    editor.completions.slice(0, 6).forEach((item, index) => {
      const marker = index === editor.selectedCompletion ? "›" : " ";
      const text = `${marker} ${item.value}  ${item.description}`.replace(/\s+$/u, "");
      rows.push(truncateToWidth(text, width));
    });
    return rows;
  }

  #renderTranscriptItem(
    item: TranscriptBlock,
    width: number,
  ): Array<[string, string]> {
    if (item.kind === "user") {
      return this.#backgroundLines(item.text, width, "user_bg", "text");
    }
    if (item.kind === "thinking") {
      return this.#plainLines(
        `thinking  ${item.text}`,
        width,
        `italic ${this.theme.color("thinking")}`,
      );
    }
    if (item.kind === "tool") {
      const status = item.status || "running";
      const isRunning = status === "running";
      const background = isRunning
        ? "tool_pending_bg"
        : status === "completed"
          ? "tool_success_bg"
          : "tool_error_bg";
      const accent = isRunning
        ? "accent"
        : status === "completed"
          ? "success"
          : "warning";
      let title = `● ${item.name || "tool"}`;
      if (item.subject) {
        title += `  ${clip(item.subject, 180)}`;
      }
      if (item.key) {
        title += `  [${item.key.slice(-8)}]`;
      }
      let detail = isRunning ? "Running…" : status;
      if (item.exitCode !== null) {
        detail += ` · exit ${item.exitCode}`;
      }
      if (item.durationMs !== null) {
        detail += ` · ${item.durationMs}ms`;
      }
      if (item.streamError) {
        detail += `\n${clip(item.streamError, 1_200)}`;
      }
      if (item.toolOutputExpanded && item.toolOutput) {
        detail += `\n${clip(item.toolOutput, 1_200)}`;
      }
      const rendered = this.#backgroundLines(`${title}\n${detail}`, width, background, "text");
      const first = rendered[0];
      if (first !== undefined) {
        rendered[0] = [
          first[0].replace(this.theme.color("text"), this.theme.color(accent)),
          first[1],
        ];
      }
      return rendered;
    }
    return this.#plainLines(item.text, width, item.style || this.theme.color("text"));
  }

  #backgroundLines(
    text: string,
    width: number,
    background: string,
    foreground: string,
  ): Array<[string, string]> {
    const style = `bg:${this.theme.color(background)} ${this.theme.color(foreground)}`;
    return wrapTextToWidth(text, width).map((line) => [
      style,
      TerminalUI.#padLine(line, width) + "\n",
    ]);
  }

  #plainLines(text: string, width: number, style: string): Array<[string, string]> {
    return wrapTextToWidth(text, width).map((line) => [style, `${line}\n`]);
  }

  static #padLine(line: string, width: number): string {
    return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  }

  // -- events ---------------------------------------------------------------

  /** Queue a projected event; the loop is the sole event writer. */
  publishEvent(event: unknown): void {
    if (this.#loop !== null) {
      this.#loop.publishEvent(event);
      return;
    }
    if (event instanceof LocalMessage) {
      this.appendTranscript(
        createTranscriptBlock("notice", this.newBlockId(), {
          text: event.text,
          style: event.style,
        }),
      );
      return;
    }
    this.applyProjectedEvent(event as UIEventLike);
  }

  /** Reduce a projected event and apply its append-only block change. */
  applyProjectedEvent(event: UIEventLike): void {
    for (const projected of this.#displayPolicy.project(event)) {
      this.#applyDisplayEvent(projected);
    }
  }

  applyDisplayAction(action: DisplayAction): void {
    if (action.type !== "toggle_tool_output") {
      return;
    }
    this.#transcript.setToolOutputExpanded(action.expanded);
    this.#loop?.requestRender();
  }

  #applyDisplayEvent(event: DisplayEvent): void {
    if (event.kind === "display.gap") {
      this.appendTranscript(createTranscriptBlock("notice", this.newBlockId(), {
        text: event.text,
        style: "yellow",
      }));
      return;
    }
    const update = this.reducer.apply({
      kind: event.kind,
      correlation_id: event.correlationId,
      payload: event.payload,
    });
    if (update !== null) {
      this.#transcript.apply(update);
    }
  }

  // -- direct user-facing writes -------------------------------------------

  write(message: string): void {
    this.#writeLocal(message);
  }

  showError(message: string): void {
    this.#writeLocal(`Error: ${message}`, `bold ${this.theme.color("error")}`);
  }

  showInterrupted(options: { operation?: boolean } = {}): void {
    const message = options.operation ? "Operation interrupted." : "Interrupted.";
    this.#writeLocal(message, this.theme.color("warning"));
  }

  showGoodbye(): void {
    if (this.#loop !== null) {
      if (!this.#loop.closed) {
        this.#writeLocal("Goodbye.", this.theme.color("dim"));
        this.flushEventRenderer();
      }
      return;
    }
    this.#output(ansiStyledText(this.theme.color("dim"), "Goodbye."));
  }

  showAssistant(response: string): void {
    if (this.#loop !== null) {
      this.appendTranscript(
        createTranscriptBlock("assistant", this.newBlockId(), { text: response }),
      );
      return;
    }
    for (const line of renderMarkdownLines(response, resolveFallbackMarkdownWidth(), this.theme)) {
      this.#output(line);
    }
  }

  showWelcome(): void {
    const details: string[] = [];
    if (this.projectRoot !== null) {
      details.push(this.projectRoot);
    }
    if (this.provider && this.model) {
      details.push(`${this.provider}/${this.model}`);
    }
    if (this.dashboardUrl) {
      details.push(`trace: ${this.dashboardUrl}`);
    }
    if (this.#loop !== null) {
      this.appendTranscript(
        createTranscriptBlock("notice", this.newBlockId(), {
          text: "laoHuangCode  /help for commands",
          style: `bold ${this.theme.color("accent")}`,
        }),
      );
      if (details.length > 0) {
        this.appendTranscript(
          createTranscriptBlock("notice", this.newBlockId(), {
            text: details.join(" · "),
            style: this.theme.color("dim"),
          }),
        );
      }
      return;
    }
    this.#output(
      ansiStyledText(`bold ${this.theme.color("accent")}`, "laoHuangCode") +
        "  " +
        ansiStyledText(this.theme.color("dim"), "/help for commands"),
    );
    if (details.length > 0) {
      this.#output(ansiStyledText(this.theme.color("dim"), details.join(" · ")));
    }
  }

  #writeLocal(message: string, style = ""): void {
    if (this.#loop !== null) {
      if (!this.#loop.closed) {
        this.#loop.publishEvent(new LocalMessage(message, style));
        return;
      }
      this.#output(ansiStyledText(style, message));
      return;
    }
    this.#output(ansiStyledText(style, message));
  }
}

// ---------------------------------------------------------------------------
// PlainEventSink — append-only renderer for non-interactive stdio
// ---------------------------------------------------------------------------

/**
 * Append-only renderer used when stdin/stdout are not interactive TTYs.
 *
 * The Python original renders from a background thread fed by a bounded
 * queue; the TS event loop is single-threaded, so events render
 * synchronously in publication order and flush()/stop() are lifecycle
 * no-ops kept for API parity. Render errors are captured, never thrown
 * back into the event bus.
 */
export class PlainEventSink {
  readonly outputFn: (text: string) => void;
  #stopped = false;
  #modelBuffers = new Map<string, string[]>();
  #displayPolicy = new DisplayPolicy({ audience: "terminal" });
  renderError: unknown = null;

  constructor(outputFn: (text: string) => void = (text) => console.log(text)) {
    this.outputFn = outputFn;
  }

  publishEvent(event: unknown): void {
    if (this.#stopped || !isRecord(event) || !("kind" in event)) {
      return;
    }
    try {
      const displayEvent: DisplayEventLike = {
        kind: event.kind,
        payload: event.payload,
        correlation_id: event.correlation_id,
      };
      for (const projected of this.#displayPolicy.project(displayEvent)) {
        if (projected.kind === "display.gap") {
          this.outputFn(`[stream output omitted: ${projected.payload.dropped} event(s); runtime continued]`);
          continue;
        }
        this.#renderEvent({
          kind: projected.kind,
          correlation_id: projected.correlationId,
          payload: projected.payload,
        });
      }
    } catch (error) {
      this.renderError = error;
    }
  }

  write(message: string): void {
    if (!this.#stopped) {
      this.outputFn(message);
    }
  }

  flush(): void {
    // Synchronous rendering drains on every publish; nothing to wait for.
  }

  stop(_options: { drain?: boolean } = {}): void {
    this.#stopped = true;
  }

  #renderEvent(event: unknown): void {
    if (!isRecord(event)) {
      return;
    }
    const kind = String(event.kind ?? "");
    const payload = isRecord(event.payload) ? event.payload : {};
    const correlationId = String(event.correlation_id ?? "").slice(-8);

    if (kind === "model.text_delta") {
      const text = String(payload.text ?? payload.chunk ?? "");
      if (text) {
        const buffer = this.#modelBuffers.get(correlationId) ?? [];
        buffer.push(text);
        this.#modelBuffers.set(correlationId, buffer);
      }
    } else if (kind === "model.response_committed") {
      const text = (this.#modelBuffers.get(correlationId) ?? []).join("");
      this.#modelBuffers.delete(correlationId);
      if (text) {
        this.outputFn(text);
      }
    } else if (kind === "model.response_aborted" || kind === "model.request_failed") {
      const text = (this.#modelBuffers.get(correlationId) ?? []).join("");
      this.#modelBuffers.delete(correlationId);
      if (text) {
        this.outputFn(text);
        this.outputFn("[response interrupted; not added to context]");
      }
    } else if (kind === "ui.message") {
      this.outputFn(String(payload.text ?? ""));
    } else if (kind === "tool.started") {
      const name = String(payload.name ?? "tool");
      this.outputFn(`[tool:${correlationId || "unknown"}] ${name} started`);
    } else if (kind === "tool.output_delta") {
      const stream = String(payload.stream ?? "stdout");
      const text = String(payload.text ?? payload.chunk ?? "");
      if (text) {
        this.outputFn(`[${correlationId || "unknown"}:${stream}] ${text}`);
      }
    } else if (kind === "tool.finished") {
      const status = String(payload.status ?? "completed");
      this.outputFn(`[tool:${correlationId || "unknown"}] ${status}`);
    } else if (kind === "task.failed") {
      this.outputFn(`Error: ${String(payload.error ?? "Task failed")}`);
    } else if (kind === "task.cancelled") {
      this.outputFn("Task cancelled; completed file changes were not reverted.");
    }
  }
}

// ---------------------------------------------------------------------------
// StdTerminalDriver — the small POSIX adapter used by the regular-screen loop
// ---------------------------------------------------------------------------

/**
 * Make terminal control bytes visible for the debug capture log: ESC becomes
 * the literal text `\x1b`, CR becomes `\r`, other C0/DEL bytes become `\xHH`.
 * Newlines are kept so the log stays line-oriented.
 */
function escapeDebugCapture(data: string): string {
  let escaped = "";
  for (const char of data) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\r") {
      escaped += "\\r";
    } else if ((code < 0x20 && char !== "\n") || code === 0x7f) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      escaped += char;
    }
  }
  return escaped;
}

/** Production terminal driver over process stdin/stdout. */
export class StdTerminalDriver implements RawTerminalDriver {
  #rawModeActive = false;
  /**
   * Debug capture target from LAOHUANG_DEBUG_LOG: when set, every write is
   * teed to this file with escape sequences made visible (for diagnosing
   * stray-character bugs in the field). Null keeps write() zero-cost.
   */
  #debugLogPath: string | null;

  constructor() {
    const path = process.env.LAOHUANG_DEBUG_LOG?.trim();
    this.#debugLogPath = path ? path : null;
  }

  get inputStream(): NodeJS.ReadStream {
    return process.stdin;
  }

  enterRawMode(): void {
    if (!process.stdin.isTTY) {
      return;
    }
    process.stdin.setRawMode(true);
    this.#rawModeActive = true;
  }

  write(data: string): void {
    if (this.#debugLogPath !== null) {
      try {
        appendFileSync(this.#debugLogPath, escapeDebugCapture(data));
      } catch {
        // Debug capture is best-effort and must never break the UI.
      }
    }
    process.stdout.write(data);
  }

  flush(): void {
    // process.stdout.write is already unbuffered from our perspective.
  }

  getSize(): { columns: number; rows: number } {
    return {
      columns: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    };
  }

  restore(): void {
    if (this.#rawModeActive) {
      process.stdin.setRawMode(false);
      this.#rawModeActive = false;
    }
  }
}
