/**
 * Raw terminal input decoding and prompt-toolkit-independent editor state.
 *
 * Port of terminal_editor.py: a byte-level stdin buffer (bracketed paste,
 * split escape sequences, kitty keyboard protocol), a terminal-negotiation
 * filter, an incremental raw-byte decoder producing editor actions, and the
 * text/history/completion state machine those actions drive.
 */

import { charCellWidth } from "./screen.ts";
import {
  makeKeyInput,
  type KeyInput,
  type TuiInputEvent,
} from "../keybindings/key-id.ts";

// The wcwidth tables and charCellWidth are owned by terminal/screen.ts;
// re-exported here for existing consumers of this module.
export { charCellWidth } from "./screen.ts";

/** Editor actions produced by {@link RawInputDecoder}. */
export const InputActionKind = {
  Insert: "insert",
  Submit: "submit",
  Newline: "newline",
  Complete: "complete",
  HistoryUp: "history_up",
  HistoryDown: "history_down",
  CursorLeft: "cursor_left",
  CursorRight: "cursor_right",
  Backspace: "backspace",
  Key: "key",
  Dismiss: "dismiss",
  Cancel: "cancel",
  Eof: "eof",
} as const;

export type InputActionKind = (typeof InputActionKind)[keyof typeof InputActionKind];

/** Events emitted by {@link StdinBuffer}. */
export const BufferedInputKind = {
  Sequence: "sequence",
  Paste: "paste",
} as const;

export type BufferedInputKind =
  (typeof BufferedInputKind)[keyof typeof BufferedInputKind];

export interface BufferedSequenceInput {
  readonly kind: typeof BufferedInputKind.Sequence;
  readonly data: Buffer;
}

export interface BufferedPasteInput {
  readonly kind: typeof BufferedInputKind.Paste;
  readonly data: Buffer;
}

export type BufferedInput = BufferedSequenceInput | BufferedPasteInput;

export interface InputAction {
  readonly kind: InputActionKind;
  readonly text: string;
  readonly key?: KeyInput;
}

export function inputAction(kind: InputActionKind, text = "", key?: KeyInput): InputAction {
  return key === undefined ? { kind, text } : { kind, text, key };
}

/** Convert existing editor actions into the neutral TUI input contract. */
export function toTuiInputEvent(action: InputAction): TuiInputEvent;
export function toTuiInputEvent(input: BufferedPasteInput): TuiInputEvent;
export function toTuiInputEvent(
  input: InputAction | BufferedPasteInput,
): TuiInputEvent {
  if (input.kind === BufferedInputKind.Paste) {
    return { type: "paste", text: input.data.toString("utf8") };
  }
  if (input.kind === InputActionKind.Key) {
    if (input.key === undefined) {
      throw new Error("key input action is missing its key");
    }
    return { type: "key", key: input.key };
  }

  switch (input.kind) {
    case InputActionKind.Insert:
      return { type: "text", text: input.text };
    case InputActionKind.Submit:
      return { type: "key", key: makeKeyInput("enter") };
    case InputActionKind.Newline:
      return { type: "key", key: makeKeyInput("enter", { alt: true }) };
    case InputActionKind.Complete:
      return { type: "key", key: makeKeyInput("tab") };
    case InputActionKind.HistoryUp:
      return { type: "key", key: makeKeyInput("up") };
    case InputActionKind.HistoryDown:
      return { type: "key", key: makeKeyInput("down") };
    case InputActionKind.CursorLeft:
      return { type: "key", key: makeKeyInput("left") };
    case InputActionKind.CursorRight:
      return { type: "key", key: makeKeyInput("right") };
    case InputActionKind.Backspace:
      return { type: "key", key: makeKeyInput("backspace") };
    case InputActionKind.Dismiss:
      return { type: "key", key: makeKeyInput("escape") };
    case InputActionKind.Cancel:
      return { type: "key", key: makeKeyInput("ctrl_c", { ctrl: true }) };
    case InputActionKind.Eof:
      return { type: "key", key: makeKeyInput("ctrl_d", { ctrl: true }) };
  }

}

/** Side effects an {@link EditorState} action asks the caller to perform. */
export interface EditorEffect {
  readonly submit: string | null;
  readonly cancelRequested: boolean;
  readonly exitRequested: boolean;
  readonly notice: string | null;
}

export function editorEffect(partial: Partial<EditorEffect> = {}): EditorEffect {
  return {
    submit: null,
    cancelRequested: false,
    exitRequested: false,
    notice: null,
    ...partial,
  };
}

/**
 * A completion independent of any particular input widget.
 *
 * Canonical definition; src/commands.ts (CommandRegistry.complete) imports
 * and re-exports it so the command layer shares one contract with the editor.
 */
export interface CompletionItem {
  readonly value: string;
  readonly description: string;
  readonly start: number;
}

const ESC = 0x1b;
const ESCAPE = Buffer.from([ESC]);
const BRACKETED_PASTE_START = Buffer.from("\x1b[200~", "latin1");
const BRACKETED_PASTE_END = Buffer.from("\x1b[201~", "latin1");
const APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const CSI_PREFIX = Buffer.from("\x1b[", "latin1");
const NEGOTIATION_QUERY_PREFIX = Buffer.from("\x1b[?", "latin1");

function startsWith(buffer: Buffer, prefix: Buffer, offset = 0): boolean {
  if (buffer.length - offset < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (buffer[offset + index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Buffer stdin bytes and emit complete Pi-compatible input events.
 *
 * Splits the byte stream into whole escape sequences / UTF-8 characters,
 * coalesces bracketed pastes, and suppresses the raw duplicate byte that
 * kitty terminals send after an unmodified printable key event.
 */
export class StdinBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private pasteMode = false;
  private pasteBuffer: Buffer = Buffer.alloc(0);
  private pendingKittyPrintableCodepoint: number | null = null;

  feed(data: Uint8Array): BufferedInput[] {
    if (data.length === 0) {
      return [];
    }
    let chunk = Buffer.from(data);
    // High-bit meta bytes (e.g. 0xE1) arrive as ESC + (byte - 128).
    if (chunk.length === 1 && chunk[0]! > 127) {
      chunk = Buffer.concat([ESCAPE, Buffer.from([chunk[0]! - 128])]);
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: BufferedInput[] = [];
    this.processBuffer(events);
    return events;
  }

  flush(): BufferedInput[] {
    if (this.pasteMode || this.buffer.length === 0) {
      return [];
    }
    const sequence = this.buffer;
    this.buffer = Buffer.alloc(0);
    this.pendingKittyPrintableCodepoint = null;
    return [{ kind: BufferedInputKind.Sequence, data: sequence }];
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
    this.pasteBuffer = Buffer.alloc(0);
    this.pasteMode = false;
    this.pendingKittyPrintableCodepoint = null;
  }

  private processBuffer(events: BufferedInput[]): void {
    if (this.pasteMode) {
      this.pasteBuffer = Buffer.concat([this.pasteBuffer, this.buffer]);
      this.buffer = Buffer.alloc(0);
      this.emitFinishedPaste(events);
      return;
    }

    const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
    if (startIndex !== -1) {
      const beforePaste = this.buffer.subarray(0, startIndex);
      const { sequences } = extractCompleteSequences(beforePaste);
      for (const sequence of sequences) {
        this.emitSequence(events, sequence);
      }
      const afterStart = this.buffer.subarray(
        startIndex + BRACKETED_PASTE_START.length,
      );
      this.buffer = Buffer.alloc(0);
      this.pasteMode = true;
      this.pasteBuffer = Buffer.concat([this.pasteBuffer, afterStart]);
      this.pendingKittyPrintableCodepoint = null;
      this.emitFinishedPaste(events);
      return;
    }

    const { sequences, remainder } = extractCompleteSequences(this.buffer);
    this.buffer = remainder;
    for (const sequence of sequences) {
      this.emitSequence(events, sequence);
    }
  }

  private emitFinishedPaste(events: BufferedInput[]): void {
    const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (endIndex === -1) {
      return;
    }
    const pasted = this.pasteBuffer.subarray(0, endIndex);
    const remaining = this.pasteBuffer.subarray(
      endIndex + BRACKETED_PASTE_END.length,
    );
    this.pasteBuffer = Buffer.alloc(0);
    this.pasteMode = false;
    this.pendingKittyPrintableCodepoint = null;
    events.push({ kind: BufferedInputKind.Paste, data: Buffer.from(pasted) });
    if (remaining.length > 0) {
      this.buffer = Buffer.concat([this.buffer, remaining]);
      this.processBuffer(events);
    }
  }

  private emitSequence(events: BufferedInput[], sequence: Buffer): void {
    const rawCodepoint = singleCodepoint(sequence);
    if (
      rawCodepoint !== null &&
      rawCodepoint === this.pendingKittyPrintableCodepoint
    ) {
      this.pendingKittyPrintableCodepoint = null;
      return;
    }
    this.pendingKittyPrintableCodepoint =
      parseUnmodifiedKittyPrintableCodepoint(sequence);
    events.push({
      kind: BufferedInputKind.Sequence,
      data: Buffer.from(sequence),
    });
  }
}

export interface TerminalInputFilterOptions {
  isAppleTerminal?: () => boolean;
  shiftPressed?: () => boolean;
  enableModifyOtherKeys?: () => void;
  disableModifyOtherKeys?: () => void;
}

const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/;
const DEVICE_ATTRIBUTES_RE = /^\x1b\[\?[\d;]*c$/;
const NEGOTIATION_PREFIX_RE = /^\x1b\[\?[\d;]*$/;
const ABANDONED_NEGOTIATION_TAIL_RE = /^\x1b\[\?[\d;]*([A-Za-z])$/;

/**
 * Filter terminal negotiation responses before editor decoding.
 *
 * Kitty keyboard flags and device-attribute answers are consumed here; an
 * abandoned negotiation prefix is dropped once real input follows. Byte
 * patterns are matched on latin1-decoded strings (a 1:1 byte mapping).
 */
export class TerminalInputFilter {
  private pendingNegotiationPrefix = "";
  private readonly isAppleTerminal: () => boolean;
  private readonly shiftPressed: () => boolean;
  private readonly enableModifyOtherKeys: () => void;
  private readonly disableModifyOtherKeys: () => void;
  kittyProtocolActive = false;

  constructor(options: TerminalInputFilterOptions = {}) {
    this.isAppleTerminal = options.isAppleTerminal ?? isAppleTerminalSession;
    this.shiftPressed = options.shiftPressed ?? (() => false);
    this.enableModifyOtherKeys = options.enableModifyOtherKeys ?? (() => {});
    this.disableModifyOtherKeys = options.disableModifyOtherKeys ?? (() => {});
  }

  feed(sequence: Uint8Array): Buffer[] {
    const text = Buffer.from(sequence).toString("latin1");
    return this.feedText(text).map((item) => Buffer.from(item, "latin1"));
  }

  flush(): Buffer[] {
    if (!this.pendingNegotiationPrefix) {
      return [];
    }
    const pending = this.pendingNegotiationPrefix;
    this.pendingNegotiationPrefix = "";
    return [Buffer.from(this.normalizePlatformInput(pending), "latin1")];
  }

  clear(): void {
    this.pendingNegotiationPrefix = "";
  }

  private feedText(sequence: string): string[] {
    if (this.pendingNegotiationPrefix) {
      const combined = this.pendingNegotiationPrefix + sequence;
      if (this.handleNegotiation(combined)) {
        this.pendingNegotiationPrefix = "";
        return [];
      }
      if (this.isNegotiationPrefix(combined)) {
        this.pendingNegotiationPrefix = combined;
        return [];
      }
      this.pendingNegotiationPrefix = "";
      return this.feedText(sequence);
    }

    const abandonedTail = this.abandonedNegotiationTail(sequence);
    if (abandonedTail !== null) {
      return this.feedText(abandonedTail);
    }
    if (this.handleNegotiation(sequence)) {
      return [];
    }
    if (this.isNegotiationPrefix(sequence)) {
      this.pendingNegotiationPrefix = sequence;
      return [];
    }
    return [this.normalizePlatformInput(sequence)];
  }

  private handleNegotiation(sequence: string): boolean {
    const flags = KITTY_FLAGS_RE.exec(sequence);
    if (flags !== null) {
      const value = Number.parseInt(flags[1]!, 10);
      if (value) {
        this.disableModifyOtherKeys();
        this.kittyProtocolActive = true;
      } else {
        this.enableModifyOtherKeys();
      }
      return true;
    }
    if (DEVICE_ATTRIBUTES_RE.test(sequence)) {
      if (!this.kittyProtocolActive) {
        this.enableModifyOtherKeys();
      }
      return true;
    }
    return false;
  }

  private isNegotiationPrefix(sequence: string): boolean {
    return sequence === "\x1b[" || NEGOTIATION_PREFIX_RE.test(sequence);
  }

  private abandonedNegotiationTail(sequence: string): string | null {
    const match = ABANDONED_NEGOTIATION_TAIL_RE.exec(sequence);
    if (match === null || match[1] === "c" || match[1] === "u") {
      return null;
    }
    return match[1]!;
  }

  private normalizePlatformInput(sequence: string): string {
    if (
      sequence === "\r" &&
      this.isAppleTerminal() &&
      this.shiftPressed()
    ) {
      return APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE;
    }
    return sequence;
  }
}

function isAppleTerminalSession(): boolean {
  return (
    process.platform === "darwin" &&
    process.env["TERM_PROGRAM"] === "Apple_Terminal"
  );
}

const ESCAPE_ACTIONS: ReadonlyMap<string, InputActionKind> = new Map([
  ["\x1b[A", InputActionKind.HistoryUp],
  ["\x1b[B", InputActionKind.HistoryDown],
  ["\x1b[C", InputActionKind.CursorRight],
  ["\x1b[D", InputActionKind.CursorLeft],
  ["\x1bOA", InputActionKind.HistoryUp],
  ["\x1bOB", InputActionKind.HistoryDown],
  ["\x1bOC", InputActionKind.CursorRight],
  ["\x1bOD", InputActionKind.CursorLeft],
]);

const CONTROL_ACTIONS: ReadonlyMap<number, InputActionKind> = new Map([
  [3, InputActionKind.Cancel],
  [4, InputActionKind.Eof],
  [9, InputActionKind.Complete],
  [8, InputActionKind.Backspace],
  [127, InputActionKind.Backspace],
]);

const CONTROL_KEYS: ReadonlyMap<number, KeyInput> = new Map([
  [12, makeKeyInput("ctrl_l", { ctrl: true })],
  [15, makeKeyInput("character", { text: "o", ctrl: true })],
  [20, makeKeyInput("character", { text: "t", ctrl: true })],
]);

type EscapeConsumption =
  | { readonly status: "incomplete" }
  | { readonly status: "consumed" }
  | { readonly status: "action"; readonly action: InputAction };

const ESCAPE_INCOMPLETE: EscapeConsumption = { status: "incomplete" };
const ESCAPE_CONSUMED: EscapeConsumption = { status: "consumed" };

/** Incrementally convert raw bytes into editor actions. */
export class RawInputDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  feed(data: Uint8Array): InputAction[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
    const actions: InputAction[] = [];
    while (this.buffer.length > 0) {
      if (this.buffer[0] === ESC) {
        const consumption = this.consumeEscape();
        if (consumption.status === "incomplete") {
          break;
        }
        if (consumption.status === "action") {
          actions.push(consumption.action);
        }
        continue;
      }
      const byte = this.buffer[0]!;
      if (byte === 10 || byte === 13) {
        this.buffer = this.buffer.subarray(1);
        actions.push(inputAction(InputActionKind.Submit));
        continue;
      }
      const key = CONTROL_KEYS.get(byte);
      if (key !== undefined) {
        this.buffer = this.buffer.subarray(1);
        actions.push(inputAction(InputActionKind.Key, "", key));
        continue;
      }
      const kind = CONTROL_ACTIONS.get(byte);
      if (kind !== undefined) {
        this.buffer = this.buffer.subarray(1);
        actions.push(inputAction(kind));
        continue;
      }
      if (byte < 32) {
        // Ignore every remaining C0 control rather than leaving a
        // zero-length printable chunk at the front of the buffer.
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      let end = 0;
      while (
        end < this.buffer.length &&
        this.buffer[end]! >= 32 &&
        this.buffer[end] !== 127
      ) {
        end += 1;
      }
      const chunk = this.buffer.subarray(0, end);
      const decoded = decodeUtf8Strict(chunk);
      if (!decoded.ok) {
        if (decoded.reason === "truncated") {
          break;
        }
        this.buffer = this.buffer.subarray(Math.max(1, decoded.start + 1));
        continue;
      }
      this.buffer = this.buffer.subarray(end);
      if (decoded.text) {
        actions.push(inputAction(InputActionKind.Insert, decoded.text));
      }
    }
    return actions;
  }

  /**
   * Resolve bytes which remain after the raw-input escape timeout.
   *
   * The event loop calls this after a short no-input interval. This keeps
   * split CSI sequences buffered, while a genuine standalone Escape can
   * dismiss a completion overlay.
   */
  flush(): InputAction[] {
    if (this.buffer.length === 1 && this.buffer[0] === ESC) {
      this.buffer = Buffer.alloc(0);
      return [inputAction(InputActionKind.Dismiss)];
    }
    if (this.buffer.length > 1 && this.buffer[0] === ESC && this.buffer[1] === 0x5b) {
      this.buffer = Buffer.alloc(0);
    }
    return this.feed(Buffer.alloc(0));
  }

  private consumeEscape(): EscapeConsumption {
    if (this.buffer.length === 1) {
      return ESCAPE_INCOMPLETE;
    }
    const second = this.buffer[1]!;
    if (second === 10 || second === 13) {
      this.buffer = this.buffer.subarray(2);
      return { status: "action", action: inputAction(InputActionKind.Newline) };
    }
    if (second === 0x5b /* [ */) {
      let final: number | null = null;
      for (let index = 2; index < this.buffer.length; index += 1) {
        const byte = this.buffer[index]!;
        if (byte >= 0x40 && byte <= 0x7e) {
          final = index;
          break;
        }
      }
      if (final === null) {
        return ESCAPE_INCOMPLETE;
      }
      const sequence = this.buffer.subarray(0, final + 1).toString("latin1");
      if (isKittyRelease(sequence)) {
        this.buffer = this.buffer.subarray(final + 1);
        return ESCAPE_CONSUMED;
      }
      const arrow = decodeKittyArrowAction(sequence);
      if (arrow !== null) {
        this.buffer = this.buffer.subarray(final + 1);
        return { status: "action", action: arrow };
      }
      const special = decodeSpecialEscapeAction(sequence);
      if (special !== null) {
        this.buffer = this.buffer.subarray(final + 1);
        return { status: "action", action: special };
      }
      const printable = decodePrintableKey(sequence);
      if (printable !== null) {
        this.buffer = this.buffer.subarray(final + 1);
        return {
          status: "action",
          action: inputAction(InputActionKind.Insert, printable),
        };
      }
      const kind = ESCAPE_ACTIONS.get(sequence);
      this.buffer = this.buffer.subarray(final + 1);
      return kind !== undefined
        ? { status: "action", action: inputAction(kind) }
        : ESCAPE_CONSUMED;
    }
    if (second === 0x4f /* O */ && this.buffer.length >= 3) {
      const sequence = this.buffer.subarray(0, 3).toString("latin1");
      const kind = ESCAPE_ACTIONS.get(sequence);
      this.buffer = this.buffer.subarray(3);
      return kind !== undefined
        ? { status: "action", action: inputAction(kind) }
        : ESCAPE_CONSUMED;
    }
    // An unsupported Alt sequence has no editor meaning; retain its character.
    this.buffer = this.buffer.subarray(1);
    return ESCAPE_CONSUMED;
  }
}

function extractCompleteSequences(buffer: Buffer): {
  sequences: Buffer[];
  remainder: Buffer;
} {
  const sequences: Buffer[] = [];
  let position = 0;
  while (position < buffer.length) {
    const remaining = buffer.subarray(position);
    if (remaining[0] === ESC) {
      if (startsWith(remaining, NEGOTIATION_QUERY_PREFIX)) {
        const nestedEscape = remaining.indexOf(ESCAPE, 2);
        if (nestedEscape !== -1) {
          position += nestedEscape;
          continue;
        }
      }
      let sequenceEnd = 1;
      let broke = false;
      while (sequenceEnd <= remaining.length) {
        const candidate = remaining.subarray(0, sequenceEnd);
        const status = completeSequenceStatus(candidate);
        if (status === "complete") {
          if (candidate.length === 2 && candidate[0] === ESC && candidate[1] === ESC) {
            const nextByte = remaining[sequenceEnd];
            if (
              nextByte !== undefined &&
              (nextByte === 0x5b /* [ */ ||
                nextByte === 0x5d /* ] */ ||
                nextByte === 0x4f /* O */ ||
                nextByte === 0x50 /* P */ ||
                nextByte === 0x5f /* _ */)
            ) {
              sequences.push(Buffer.from(ESCAPE));
              position += 1;
              broke = true;
              break;
            }
          }
          sequences.push(Buffer.from(candidate));
          position += sequenceEnd;
          broke = true;
          break;
        }
        if (status === "incomplete") {
          sequenceEnd += 1;
          continue;
        }
        sequences.push(Buffer.from(candidate));
        position += sequenceEnd;
        broke = true;
        break;
      }
      if (!broke && sequenceEnd > remaining.length) {
        return { sequences, remainder: Buffer.from(remaining) };
      }
      continue;
    }

    const nextEscape = remaining.indexOf(ESCAPE);
    if (nextEscape === -1) {
      const { sequences: plain, remainder } = extractPlainSequences(remaining);
      sequences.push(...plain);
      position = buffer.length;
      if (remainder.length > 0) {
        return { sequences, remainder };
      }
    } else if (nextEscape === 0) {
      continue;
    } else {
      const { sequences: plain, remainder } = extractPlainSequences(
        remaining.subarray(0, nextEscape),
      );
      sequences.push(...plain);
      if (remainder.length > 0) {
        return {
          sequences,
          remainder: Buffer.concat([remainder, remaining.subarray(nextEscape)]),
        };
      }
      position += nextEscape;
    }
  }
  return { sequences, remainder: Buffer.alloc(0) };
}

function extractPlainSequences(data: Buffer): {
  sequences: Buffer[];
  remainder: Buffer;
} {
  const sequences: Buffer[] = [];
  let position = 0;
  while (position < data.length) {
    const length = utf8SequenceLength(data[position]!);
    const chunk = data.subarray(position, position + length);
    if (chunk.length < length) {
      return { sequences, remainder: Buffer.from(data.subarray(position)) };
    }
    if (!isValidUtf8(chunk)) {
      sequences.push(Buffer.from(data.subarray(position, position + 1)));
      position += 1;
      continue;
    }
    sequences.push(Buffer.from(chunk));
    position += length;
  }
  return { sequences, remainder: Buffer.alloc(0) };
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte < 0x80) {
    return 1;
  }
  if (firstByte >= 0xc0 && firstByte <= 0xdf) {
    return 2;
  }
  if (firstByte >= 0xe0 && firstByte <= 0xef) {
    return 3;
  }
  if (firstByte >= 0xf0 && firstByte <= 0xf7) {
    return 4;
  }
  return 1;
}

type SequenceStatus = "complete" | "incomplete" | "not-escape";

function completeSequenceStatus(data: Buffer): SequenceStatus {
  if (data[0] !== ESC) {
    return "not-escape";
  }
  if (data.length === 1) {
    return "incomplete";
  }
  const second = data[1]!;
  if (second === 0x5b /* [ */ && data[2] === 0x4d /* M */) {
    return data.length >= 6 ? "complete" : "incomplete";
  }
  if (second === 0x5b /* [ */) {
    return completeCsiStatus(data);
  }
  if (second === 0x5d /* ] */) {
    return endsWithEscapeBackslash(data) || data[data.length - 1] === 0x07
      ? "complete"
      : "incomplete";
  }
  if (second === 0x50 /* P */ || second === 0x5f /* _ */) {
    return endsWithEscapeBackslash(data) ? "complete" : "incomplete";
  }
  if (second === 0x4f /* O */) {
    return data.length >= 3 ? "complete" : "incomplete";
  }
  return "complete";
}

function endsWithEscapeBackslash(data: Buffer): boolean {
  return (
    data.length >= 2 &&
    data[data.length - 2] === ESC &&
    data[data.length - 1] === 0x5c /* \ */
  );
}

const SGR_MOUSE_RE = /^<\d+;\d+;\d+[Mm]$/;

function completeCsiStatus(data: Buffer): SequenceStatus {
  if (!startsWith(data, CSI_PREFIX)) {
    return "complete";
  }
  if (data.length < 3) {
    return "incomplete";
  }
  const payload = data.subarray(2).toString("latin1");
  const finalByte = payload.charCodeAt(payload.length - 1);
  if (!(finalByte >= 0x40 && finalByte <= 0x7e)) {
    return "incomplete";
  }
  if (payload.startsWith("<")) {
    if (SGR_MOUSE_RE.test(payload)) {
      return "complete";
    }
    if (finalByte === 0x4d /* M */ || finalByte === 0x6d /* m */) {
      const parts = payload.slice(1, -1).split(";");
      if (parts.length === 3 && parts.every((part) => /^\d+$/.test(part))) {
        return "complete";
      }
    }
    return "incomplete";
  }
  return "complete";
}

type StrictDecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "truncated" }
  | { readonly ok: false; readonly reason: "invalid"; readonly start: number };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isValidUtf8(chunk: Buffer): boolean {
  try {
    utf8Decoder.decode(chunk);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict UTF-8 decode mirroring CPython's error semantics: "truncated" for
 * an incomplete sequence at the end of the chunk ("unexpected end of data"),
 * otherwise "invalid" with `start` at the offending sequence's first byte.
 */
function decodeUtf8Strict(chunk: Buffer): StrictDecodeResult {
  let index = 0;
  while (index < chunk.length) {
    const byte = chunk[index]!;
    let length: number;
    if (byte < 0x80) {
      index += 1;
      continue;
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      length = 2;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      length = 3;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      length = 4;
    } else {
      return { ok: false, reason: "invalid", start: index };
    }
    let truncated = false;
    for (let offset = 1; offset < length; offset += 1) {
      if (index + offset >= chunk.length) {
        truncated = true;
        break;
      }
      const continuation = chunk[index + offset]!;
      if (continuation < 0x80 || continuation > 0xbf) {
        return { ok: false, reason: "invalid", start: index };
      }
    }
    if (truncated) {
      return { ok: false, reason: "truncated" };
    }
    const secondByte = chunk[index + 1]!;
    // Reject overlong encodings, UTF-16 surrogates and out-of-range points.
    if (
      (byte === 0xe0 && secondByte < 0xa0) ||
      (byte === 0xed && secondByte > 0x9f) ||
      (byte === 0xf0 && secondByte < 0x90) ||
      (byte === 0xf4 && secondByte > 0x8f)
    ) {
      return { ok: false, reason: "invalid", start: index };
    }
    index += length;
  }
  return { ok: true, text: chunk.toString("utf8") };
}

function singleCodepoint(sequence: Buffer): number | null {
  let text: string;
  try {
    text = utf8Decoder.decode(sequence);
  } catch {
    return null;
  }
  const chars = [...text];
  if (chars.length !== 1) {
    return null;
  }
  return chars[0]!.codePointAt(0)!;
}

const UNMODIFIED_KITTY_PRINTABLE_RE = /^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/;

function parseUnmodifiedKittyPrintableCodepoint(sequence: Buffer): number | null {
  const match = UNMODIFIED_KITTY_PRINTABLE_RE.exec(sequence.toString("latin1"));
  if (match === null) {
    return null;
  }
  const codepoint = Number.parseInt(match[1]!, 10);
  return codepoint >= 32 ? codepoint : null;
}

const KITTY_RELEASE_MARKERS = [":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F"];

function isKittyRelease(sequence: string): boolean {
  if (sequence.includes("\x1b[200~")) {
    return false;
  }
  return KITTY_RELEASE_MARKERS.some((marker) => sequence.includes(marker));
}

const KITTY_ARROW_RE = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/;

const KITTY_ARROW_ACTIONS: ReadonlyMap<string, InputActionKind> = new Map([
  ["A", InputActionKind.HistoryUp],
  ["B", InputActionKind.HistoryDown],
  ["C", InputActionKind.CursorRight],
  ["D", InputActionKind.CursorLeft],
]);

function decodeKittyArrowAction(sequence: string): InputAction | null {
  const match = KITTY_ARROW_RE.exec(sequence);
  if (match === null) {
    return null;
  }
  const modifier = Number.parseInt(match[1]!, 10) - 1;
  if (modifier !== 0) {
    return null;
  }
  const eventType = Number.parseInt(match[2] ?? "1", 10);
  if (eventType === 3) {
    return null;
  }
  const kind = KITTY_ARROW_ACTIONS.get(match[3]!);
  return kind !== undefined ? inputAction(kind) : null;
}

const SPECIAL_ESCAPE_ACTIONS: ReadonlyMap<string, InputActionKind> = new Map([
  ["\x1b[13;2u", InputActionKind.Newline],
  ["\x1b[57414;2u", InputActionKind.Newline],
  ["\x1b[13u", InputActionKind.Submit],
  ["\x1b[13;1u", InputActionKind.Submit],
  ["\x1b[57414u", InputActionKind.Submit],
  ["\x1b[57414;1u", InputActionKind.Submit],
  ["\x1b[9u", InputActionKind.Complete],
  ["\x1b[9;1u", InputActionKind.Complete],
  ["\x1b[127u", InputActionKind.Backspace],
  ["\x1b[127;1u", InputActionKind.Backspace],
  ["\x1b[27u", InputActionKind.Dismiss],
  ["\x1b[27;1u", InputActionKind.Dismiss],
]);

function decodeSpecialEscapeAction(sequence: string): InputAction | null {
  const kind = SPECIAL_ESCAPE_ACTIONS.get(sequence);
  return kind !== undefined ? inputAction(kind) : null;
}

function decodePrintableKey(sequence: string): string | null {
  const kitty = decodeKittyPrintable(sequence);
  if (kitty !== null) {
    return kitty;
  }
  return decodeModifyOtherKeysPrintable(sequence);
}

const KITTY_PRINTABLE_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

function decodeKittyPrintable(sequence: string): string | null {
  const match = KITTY_PRINTABLE_RE.exec(sequence);
  if (match === null) {
    return null;
  }
  const codepoint = Number.parseInt(match[1]!, 10);
  const shifted = match[2];
  const shiftedCodepoint = shifted ? Number.parseInt(shifted, 10) : null;
  const modifier = Number.parseInt(match[4] ?? "1", 10) - 1;
  const lockMask = 64 + 128;
  if (modifier & ~(1 | lockMask)) {
    return null;
  }
  if (modifier & (2 | 4)) {
    return null;
  }
  const effective =
    (modifier & 1) !== 0 && shiftedCodepoint !== null
      ? shiftedCodepoint
      : codepoint;
  if (effective < 32) {
    return null;
  }
  try {
    return String.fromCodePoint(effective);
  } catch {
    return null;
  }
}

const MODIFY_OTHER_KEYS_PRINTABLE_RE = /^\x1b\[27;(\d+);(\d+)~$/;

function decodeModifyOtherKeysPrintable(sequence: string): string | null {
  const match = MODIFY_OTHER_KEYS_PRINTABLE_RE.exec(sequence);
  if (match === null) {
    return null;
  }
  const modifier = Number.parseInt(match[1]!, 10) - 1;
  if (modifier & ~1) {
    return null;
  }
  const codepoint = Number.parseInt(match[2]!, 10);
  if (codepoint < 32) {
    return null;
  }
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return null;
  }
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charCellWidth(char);
  }
  return width;
}

// ---------------------------------------------------------------------------
// Editor state
// ---------------------------------------------------------------------------

export interface RenderedEditor {
  readonly lines: string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
}

export interface RenderOptions {
  readonly prompt?: string;
  readonly mask?: boolean;
}

/** Text, history, and command-completion state for the active editor. */
export class EditorState {
  /** Window for the Pi-style double-Ctrl+C-to-exit gesture, in milliseconds. */
  static readonly DOUBLE_CANCEL_EXIT_MS = 500;

  text = "";
  cursor = 0;
  history: string[] = [];
  historyIndex: number | null = null;
  private historyDraft = "";
  completions: CompletionItem[] = [];
  selectedCompletion: number | null = null;
  private lastCancelAt: number | null = null;

  get completionVisible(): boolean {
    return this.completions.length > 0;
  }

  setCompletions(values: readonly CompletionItem[]): void {
    this.completions = this.text.startsWith("/") ? [...values] : [];
    this.selectedCompletion = this.completions.length > 0 ? 0 : null;
  }

  apply(
    action: InputAction,
    { runtimeActive }: { runtimeActive: boolean },
  ): EditorEffect {
    if (action.kind === InputActionKind.Submit) {
      if (this.completionVisible) {
        this.acceptCompletion();
        if (!this.text.startsWith("/")) {
          return editorEffect();
        }
      }
      return this.submit();
    }
    if (action.kind === InputActionKind.Newline) {
      this.insert("\n");
      return editorEffect();
    }
    if (action.kind === InputActionKind.Cancel) {
      return this.cancelOrClear(runtimeActive);
    }
    if (action.kind === InputActionKind.Eof) {
      return this.exitOrNotice(runtimeActive);
    }
    if (action.kind === InputActionKind.Dismiss) {
      this.clearCompletions();
      return editorEffect();
    }
    return this.applyEditAction(action);
  }

  renderLines(width: number, options: RenderOptions = {}): RenderedEditor {
    const prompt = options.prompt ?? "❯ ";
    const mask = options.mask ?? false;
    const boundedWidth = Math.max(3, width);
    const promptWidth = Math.max(1, displayWidth(prompt));
    const contentWidth = Math.max(1, boundedWidth - promptWidth);
    const displayText = mask ? "*".repeat(this.text.length) : this.text;
    const sourceLines = displayText.split("\n");
    const rows: string[] = [];
    for (const source of sourceLines) {
      rows.push(...wrapLine(source, contentWidth));
    }
    const lastLine = sourceLines[sourceLines.length - 1]!;
    if (
      displayText &&
      !displayText.endsWith("\n") &&
      displayWidth(lastLine) % contentWidth === 0
    ) {
      rows.push("");
    }
    const lines = rows.map(
      (row, index) => (index === 0 ? prompt : " ".repeat(promptWidth)) + row,
    );
    const before = displayText.slice(0, this.cursor);
    const beforeLines = before.split("\n");
    let priorRows = 0;
    for (const line of beforeLines.slice(0, -1)) {
      priorRows += wrapLine(line, contentWidth).length;
    }
    const current = beforeLines[beforeLines.length - 1]!;
    const [currentRow, currentColumn] = cursorPosition(current, contentWidth);
    const cursorRow = priorRows + currentRow;
    const cursorColumn = promptWidth + currentColumn;
    return {
      lines,
      cursorRow: Math.min(cursorRow, lines.length - 1),
      cursorColumn: Math.min(cursorColumn, boundedWidth - 1),
    };
  }

  private submit(): EditorEffect {
    const submitted = this.text;
    this.clearCompletions();
    this.text = "";
    this.cursor = 0;
    this.historyIndex = null;
    this.historyDraft = "";
    if (!submitted) {
      return editorEffect();
    }
    this.history = [...this.history, submitted];
    return editorEffect({ submit: submitted });
  }

  private cancelOrClear(runtimeActive: boolean): EditorEffect {
    if (runtimeActive) {
      // Cancelling a task must not arm (or consume) the exit window.
      this.lastCancelAt = null;
      return editorEffect({ cancelRequested: true });
    }
    // Pi semantics (pi-coding-agent handleCtrlC): a second idle Ctrl+C within
    // the window exits; the first one just clears the editor.
    const now = performance.now();
    if (
      this.lastCancelAt !== null &&
      now - this.lastCancelAt <= EditorState.DOUBLE_CANCEL_EXIT_MS
    ) {
      this.lastCancelAt = null;
      return editorEffect({ exitRequested: true });
    }
    this.lastCancelAt = now;
    this.text = "";
    this.cursor = 0;
    this.historyIndex = null;
    this.clearCompletions();
    return editorEffect();
  }

  private exitOrNotice(runtimeActive: boolean): EditorEffect {
    if (runtimeActive) {
      return editorEffect({
        notice: "A task is still running. Press Ctrl+C to cancel it.",
      });
    }
    if (this.text) {
      return editorEffect({ notice: "Clear the editor before exiting." });
    }
    return editorEffect({ exitRequested: true });
  }

  private applyEditAction(action: InputAction): EditorEffect {
    if (action.kind === InputActionKind.HistoryUp && this.completionVisible) {
      this.moveCompletion(-1);
    } else if (
      action.kind === InputActionKind.HistoryDown &&
      this.completionVisible
    ) {
      this.moveCompletion(1);
    } else if (action.kind === InputActionKind.Insert) {
      this.insert(action.text);
    } else if (action.kind === InputActionKind.Backspace && this.cursor > 0) {
      this.clearCompletions();
      this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
      this.cursor -= 1;
    } else if (action.kind === InputActionKind.CursorLeft) {
      this.clearCompletions();
      this.cursor = Math.max(0, this.cursor - 1);
    } else if (action.kind === InputActionKind.CursorRight) {
      this.clearCompletions();
      this.cursor = Math.min(this.text.length, this.cursor + 1);
    } else if (action.kind === InputActionKind.HistoryUp) {
      this.historyUp();
    } else if (action.kind === InputActionKind.HistoryDown) {
      this.historyDown();
    } else if (action.kind === InputActionKind.Complete) {
      this.acceptCompletion();
    }
    this.closeCompletionIfContextLost();
    return editorEffect();
  }

  private insert(text: string): void {
    this.clearCompletions();
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this.historyIndex = null;
  }

  private acceptCompletion(): void {
    if (this.selectedCompletion === null) {
      return;
    }
    const item = this.completions[this.selectedCompletion];
    if (item === undefined) {
      return;
    }
    const start = Math.max(0, this.cursor + item.start);
    this.text = this.text.slice(0, start) + item.value + this.text.slice(this.cursor);
    this.cursor = start + item.value.length;
    this.clearCompletions();
  }

  private moveCompletion(offset: number): void {
    if (this.selectedCompletion === null) {
      return;
    }
    this.selectedCompletion =
      (this.selectedCompletion + offset + this.completions.length) %
      this.completions.length;
  }

  private historyUp(): void {
    if (this.history.length === 0) {
      return;
    }
    if (this.historyIndex === null) {
      this.historyDraft = this.text;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }
    this.text = this.history[this.historyIndex]!;
    this.cursor = this.text.length;
  }

  private historyDown(): void {
    if (this.historyIndex === null) {
      return;
    }
    if (this.historyIndex === this.history.length - 1) {
      this.text = this.historyDraft;
      this.historyIndex = null;
    } else {
      this.historyIndex += 1;
      this.text = this.history[this.historyIndex]!;
    }
    this.cursor = this.text.length;
  }

  private closeCompletionIfContextLost(): void {
    if (!this.text.startsWith("/")) {
      this.clearCompletions();
    }
  }

  private clearCompletions(): void {
    this.completions = [];
    this.selectedCompletion = null;
  }
}

function wrapLine(text: string, width: number): string[] {
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;
  for (const char of text) {
    const charWidth = Math.max(1, charCellWidth(char));
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

function cursorPosition(text: string, width: number): [number, number] {
  let row = 0;
  let column = 0;
  for (const char of text) {
    const charWidth = Math.max(1, charCellWidth(char));
    if (column && column + charWidth > width) {
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
