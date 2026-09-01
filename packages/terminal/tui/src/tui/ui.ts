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
 *   EditorLike/InputDecoderLike interfaces for tests and alternate hosts, but
 *   the built-in path uses the canonical TUI editor/input pipeline.
 */

import { appendFileSync } from "node:fs";

export { toTuiInputEvent } from "./editor.ts";
export type {
  EditorEffect,
  InputAction,
  InputActionKind,
} from "./editor.ts";
export type {
  CompletionItemLike,
  EditorFactory,
  EditorLike,
  EditorRenderResult,
  InputDecoderFactory,
  InputDecoderHooks,
  InputDecoderLike,
} from "./contracts.ts";
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
} from "./state.ts";
import {
  DisplayPolicy,
  displayGapMessage,
  type DisplayEvent,
  type DisplayEventLike,
} from "./display-policy.ts";
import type { DisplayAction } from "./display-actions.ts";
import {
  TranscriptStore,
  createAssistantBlock,
  createNoticeBlock,
  createUserBlock,
  createWelcomeBlock,
  type TranscriptBlock,
  type NoticeTone,
  type RestoredTranscriptItemLike,
} from "./transcript-store.ts";
import {
  EditorState,
  InputActionKind,
  inputAction,
  toTuiInputEvent,
  type EditorEffect,
  type InputAction,
} from "./editor.ts";
import type {
  CompletionItemLike,
  EditorFactory,
  EditorLike,
  InputDecoderFactory,
  InputDecoderHooks,
  InputDecoderLike,
} from "./contracts.ts";
import { FrameBuilder } from "./frame-builder.ts";
import { renderMarkdownLines } from "./markdown.ts";
import { compileStyledLines } from "./ansi-renderer.ts";
import { CompletionPopup } from "./components/completion-list.ts";
import { Composer } from "./components/composer.ts";
import { StatusLine } from "./components/status-line.ts";
import { MainScreen } from "./main-screen.ts";
import { truncateStyledLine } from "./render-model.ts";
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
import { COMPLETION_OVERLAY, COMPOSER_COMPONENT } from "./components.ts";
import type { PromptRequest, SelectionRequest } from "./components/views/contracts.ts";
import { Transcript } from "./components/transcript.ts";
import { FocusManager } from "./focus-manager.ts";
import { OverlayManager } from "./overlay-manager.ts";
import { TerminalInputDecoder } from "./terminal-input-decoder.ts";
import { ViewHost } from "./view-host.ts";

const WELCOME_TEXT = "Welcome to LaoHuang Code!";
const WELCOME_HELP_TEXT = "Send /help for help information.";

/** Slash-command completion source supplied by the host application. */
export interface CommandRegistryLike {
  complete(text: string, options: { state: string }): CompletionItemLike[];
}

export {
  createAssistantBlock,
  createNoticeBlock,
  createThinkingBlock,
  createToolBlock,
  createUserBlock,
  createWelcomeBlock,
  type TranscriptBlock,
} from "./transcript-store.ts";

/** Local command feedback sharing the loop's event queue. */
class LocalMessage {
  readonly text: string;
  readonly tone: NoticeTone;

  constructor(text: string, tone: NoticeTone = "info") {
    this.text = text;
    this.tone = tone;
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

function ansiNoticeStyle(theme: TerminalTheme, tone: NoticeTone): string {
  if (tone === "error") return `bold ${theme.color("error")}`;
  if (tone === "warning") return theme.color("warning");
  if (tone === "success") return theme.color("success");
  if (tone === "dim") return theme.color("dim");
  return "";
}

// ---------------------------------------------------------------------------
// InteractiveTerminalLoop — serialize stdin, UI events, and terminal writes
// ---------------------------------------------------------------------------

type LoopWorkItem =
  | { type: "input"; data: Uint8Array }
  | { type: "event"; event: unknown }
  | {
    type: "open_selection";
    request: SelectionRequest;
    resolve: (value: string | null) => void;
  }
  | {
    type: "open_prompt";
    request: PromptRequest;
    resolve: (value: string | null) => void;
  }
  | { type: "close_view"; value: string | null };

export interface SubmitOptions {
  readonly strategy?: "follow_up" | "steer";
}

type SubmitCallback = (text: string, options?: SubmitOptions) => void;

/** Minimal readable-source contract for the production run loop. */
export interface LoopInputSource {
  on(event: "data", listener: (data: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  off?(event: "data" | "end", listener: (...args: never[]) => void): unknown;
  /** Stop flowing mode so the handle no longer keeps the event loop alive. */
  pause?(): unknown;
}

/** A terminal driver that may support raw-mode entry (POSIX TTY). */
export type RawTerminalDriver = TerminalDriver & {
  enterRawMode?: () => void;
  onResize?: (callback: () => void) => () => void;
};

function editorActionForKey(key: KeyInput): InputAction | null {
  if (key.id === "enter") return inputAction(InputActionKind.Submit);
  if (key.id === "tab") return inputAction(InputActionKind.Complete);
  if (key.id === "up") return inputAction(InputActionKind.HistoryUp);
  if (key.id === "down") return inputAction(InputActionKind.HistoryDown);
  if (key.id === "left") return inputAction(InputActionKind.CursorLeft);
  if (key.id === "right") return inputAction(InputActionKind.CursorRight);
  if (key.id === "backspace") return inputAction(InputActionKind.Backspace);
  if (key.id === "ctrl_d") return inputAction(InputActionKind.Eof);
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
  #overlays = new OverlayManager();
  #focus = new FocusManager(this.#overlays, COMPOSER_COMPONENT);
  #viewHost = new ViewHost(this.#overlays);
  #onSubmit: SubmitCallback = () => {};
  #exitRequested = false;
  #closed = false;
  #running = false;
  #needsRender = true;
  #terminalModesStarted = false;
  #keyboardProtocolPushed = false;
  #modifyOtherKeysActive = false;
  #exitResolve: (() => void) | null = null;
  #escapeTimer: ReturnType<typeof setTimeout> | null = null;
  #wakeupEnabled = false;
  #wakeupScheduled = false;
  #disposeResize: (() => void) | null = null;
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

  start(onSubmit: SubmitCallback): void {
    this.#onSubmit = onSubmit;
    this.#exitRequested = false;
    this.#running = true;
    this.#startResizeWatcher();
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

  openSelection(request: SelectionRequest): Promise<string | null> {
    return this.#queueView("open_selection", request);
  }

  openPrompt(request: PromptRequest): Promise<string | null> {
    return this.#queueView("open_prompt", request);
  }

  closeActiveView(value: string | null = null): void {
    if (this.#closed) {
      return;
    }
    this.#work.push({ type: "close_view", value });
    this.#scheduleWakeup();
  }

  focusedComponentId(): string {
    return this.#focus.current();
  }

  renderActiveView(context: { width: number; theme: TerminalTheme }) {
    return this.#viewHost.render(context);
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
    this.#cancelPendingViews();
    this.#viewHost.closeAll();
    if (this.#escapeTimer !== null) {
      clearTimeout(this.#escapeTimer);
      this.#escapeTimer = null;
    }
    this.#stopResizeWatcher();
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
    this.#driver.write("\x1b[5 q");
    this.#driver.write("\x1b[?2004h");
    this.#keyboardProtocolPushed = true;
    this.#driver.write("\x1b[>7u\x1b[?u\x1b[c");
    this.#driver.flush();
  }

  #startResizeWatcher(): void {
    if (this.#disposeResize !== null) {
      return;
    }
    this.#disposeResize = this.#driver.onResize?.(() => {
      this.requestRender();
    }) ?? null;
  }

  #stopResizeWatcher(): void {
    const dispose = this.#disposeResize;
    this.#disposeResize = null;
    dispose?.();
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
        if (!this.#wakeupEnabled) {
          this.#applyActions(this.#decoder.flush());
        }
        changed = true;
      } else if (item.type === "open_selection") {
        this.#viewHost.openSelection(item.request).then(item.resolve);
        changed = true;
      } else if (item.type === "open_prompt") {
        this.#viewHost.openPrompt(item.request).then(item.resolve);
        changed = true;
      } else if (item.type === "close_view") {
        this.#viewHost.closeActive(item.value);
        changed = true;
      } else if (item.event instanceof LocalMessage) {
        const message = item.event;
        this.#ui.appendTranscript(
          createNoticeBlock(this.#ui.newBlockId(), message.text, message.tone),
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
      this.#renderer.render(
        this.#ui.buildFrame({
          width: Math.max(1, this.#driver.getSize().columns),
          editor: this.#editor,
        }),
      );
    } catch (error) {
      this.writeError = error;
      this.requestExit();
    }
  }

  #applyActions(actions: readonly InputAction[]): void {
    for (const action of actions) {
      if (action.kind === InputActionKind.Newline) {
        if (this.#viewHost.activeId() !== null) {
          this.#viewHost.handleInput({ type: "text", text: "\n" });
          this.#needsRender = true;
          continue;
        }
        this.#applyEditorAction(action);
        continue;
      }
      this.#applyInputEvent(toTuiInputEvent(action));
    }
  }

  #applyInputEvent(event: TuiInputEvent): void {
    if (this.#viewHost.handleInput(event)) {
      this.#needsRender = true;
      return;
    }
    if (event.type === "text" || event.type === "paste") {
      this.#applyEditorAction(inputAction(InputActionKind.Insert, event.text));
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
      this.#applyEditorAction(inputAction(InputActionKind.Newline));
    } else if (action === "steer_now") {
      this.#applySteerSubmit();
    } else if (action === "submit_follow_up") {
      this.#applyFollowUpSubmit();
    } else if (action === "dismiss") {
      this.#applyDismissAction();
    } else if (action === "cancel") {
      this.#applyEditorAction(inputAction(InputActionKind.Cancel));
    } else if (action === "toggle_tool_output") {
      this.#ui.toggleToolOutputFromKeybinding();
      this.#needsRender = true;
    } else {
      this.#ui.handleKeyAction(action);
      this.#needsRender = true;
    }
  }

  #applyDismissAction(): void {
    if (this.#applyCompletionAction(inputAction(InputActionKind.Dismiss))) {
      this.#needsRender = true;
      return;
    }
    if (this.#ui.isRunning()) {
      this.#ui.cancelFromKeybinding();
      this.#needsRender = true;
      return;
    }
    this.#applyEditorAction(inputAction(InputActionKind.Dismiss));
  }

  #applyFollowUpSubmit(): void {
    if (this.#applyCompletionAction(inputAction(InputActionKind.Submit))) {
      this.#needsRender = true;
      return;
    }
    const effect = this.#editor.apply(
      inputAction(InputActionKind.Submit),
      { runtimeActive: this.#ui.isRunning() },
    );
    if (effect.submit !== null && effect.submit !== undefined) {
      this.#ui.acceptUserInput(effect.submit);
      this.#onSubmit(effect.submit, { strategy: "follow_up" });
    }
    if (effect.notice) {
      this.#appendNotice(effect.notice);
    }
    if (effect.cancelRequested) {
      this.#ui.cancelFromKeybinding();
    }
    if (effect.exitRequested) {
      this.requestExit();
    }
    this.#syncCompletionOverlay();
    this.#needsRender = true;
  }

  #applySteerSubmit(): void {
    if (this.#applyCompletionAction(inputAction(InputActionKind.Submit))) {
      this.#needsRender = true;
      return;
    }
    const effect = this.#editor.apply(
      inputAction(InputActionKind.Submit),
      { runtimeActive: this.#ui.isRunning() },
    );
    if (effect.submit !== null && effect.submit !== undefined) {
      this.#ui.acceptUserInput(effect.submit);
      this.#onSubmit(effect.submit, { strategy: "steer" });
    } else if (this.#ui.isRunning()) {
      this.#onSubmit("", { strategy: "steer" });
    }
    if (effect.notice) {
      this.#appendNotice(effect.notice);
    }
    if (effect.cancelRequested) {
      this.#ui.cancelFromKeybinding();
    }
    if (effect.exitRequested) {
      this.requestExit();
    }
    this.#syncCompletionOverlay();
    this.#needsRender = true;
  }

  #applyEditorAction(action: InputAction): void {
    if (this.#applyCompletionAction(action)) {
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

  /** Completion owns navigation and acceptance while text edits stay in the composer. */
  #applyCompletionAction(action: InputAction): boolean {
    if (this.#focus.current() !== COMPLETION_OVERLAY.id) {
      return false;
    }
    if (
      action.kind !== InputActionKind.Dismiss &&
      action.kind !== InputActionKind.HistoryUp &&
      action.kind !== InputActionKind.HistoryDown &&
      action.kind !== InputActionKind.Complete &&
      action.kind !== InputActionKind.Submit
    ) {
      return false;
    }
    this.#applyEffect(
      this.#editor.apply(action, { runtimeActive: this.#ui.isRunning() }),
    );
    this.#syncCompletionOverlay();
    return true;
  }

  #applyEof(): void {
    const effect = this.#editor.apply(
      inputAction(InputActionKind.Eof),
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

  #appendNotice(text: string): void {
    this.#ui.appendTranscript(
      createNoticeBlock(this.#ui.newBlockId(), text, "warning"),
    );
  }

  #refreshCompletions(): void {
    const registry = this.#ui.commandRegistry;
    if (registry !== null) {
      this.#editor.setCompletions(
        registry.complete(this.#editor.text, {
          state: this.#ui.isRunning() ? "RUNNING_MODEL" : this.#ui.state.sessionState,
        }),
      );
    }
    this.#syncCompletionOverlay();
  }

  #syncCompletionOverlay(): void {
    if (this.#editor.completions.length > 0) {
      this.#overlays.open(COMPLETION_OVERLAY);
    } else {
      this.#overlays.close(COMPLETION_OVERLAY.id);
    }
  }

  #queueView(
    type: "open_selection" | "open_prompt",
    request: SelectionRequest | PromptRequest,
  ): Promise<string | null> {
    if (this.#closed || !this.#running) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      if (type === "open_selection") {
        this.#work.push({
          type,
          request: request as SelectionRequest,
          resolve,
        });
      } else {
        this.#work.push({
          type,
          request: request as PromptRequest,
          resolve,
        });
      }
      this.#scheduleWakeup();
    });
  }

  #cancelPendingViews(): void {
    const retained: LoopWorkItem[] = [];
    for (const item of this.#work) {
      if (item.type === "open_selection" || item.type === "open_prompt") {
        item.resolve(null);
      } else {
        retained.push(item);
      }
    }
    this.#work = retained;
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
  contextWindow?: number;
  effort?: string;
  version?: string;
  sessionId?: string;
  commandRegistry?: CommandRegistryLike | null;
  cancelCallback?: (() => void) | null;
  theme?: string | null;
  driver?: RawTerminalDriver | null;
  editorFactory?: EditorFactory;
  decoderFactory?: InputDecoderFactory;
  /** Non-loop prompt fallback (setup questions outside a live session). */
  askFallback?: (message: string, secret: boolean) => Promise<string>;
  capabilities?: Partial<RuntimeCapabilities>;
  keybindingOverrides?: KeybindingOverrides;
  keyActionCallback?: (action: Exclude<ActionId, "editor_newline" | "steer_now" | "submit_follow_up" | "dismiss" | "cancel">) => void;
}

type MutableRuntimeCapabilities = {
  -readonly [K in keyof RuntimeCapabilities]: RuntimeCapabilities[K];
};

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

function normalizePositiveInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
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
  cancelCallback: (() => void) | null;
  runtimeRunningCallback: (() => boolean) | null = null;

  readonly projectRoot: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly #version: string;
  #sessionId: string | null;
  readonly capabilities: RuntimeCapabilities;
  readonly keybindings: KeybindingsManager;

  #output: (text: string) => void;
  #askFallback: ((message: string, secret: boolean) => Promise<string>) | null;
  #loop: InteractiveTerminalLoop | null = null;
  readonly #transcript: TranscriptStore;
  readonly #transcriptView: Transcript;
  #showReasoning = true;
  #displayPolicy = new DisplayPolicy({
    audience: "terminal",
    foldToolOutput: false,
    showReasoning: true,
  });
  readonly #frameBuilder: FrameBuilder;
  #pendingDisplayDrops = 0;
  #keyActionCallback: ((action: Exclude<ActionId, "editor_newline" | "steer_now" | "submit_follow_up" | "dismiss" | "cancel">) => void) | null;

  constructor(options: TerminalUIOptions = {}) {
    this.theme = resolveTerminalTheme(options.theme);
    this.projectRoot = options.projectRoot ?? null;
    this.provider = options.provider ?? null;
    this.model = options.model ?? null;
    this.effort = options.effort ?? null;
    this.#version = options.version ?? "0.0.0";
    this.#sessionId = options.sessionId ?? null;
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
    this.state.contextWindow = normalizePositiveInteger(options.contextWindow);
    this.reducer = new UIEventReducer(this.state);
    this.#transcript = new TranscriptStore({
      errorStyle: `bold ${this.theme.color("error")}`,
    });
    this.#transcriptView = new Transcript({
      blocks: this.#transcript.blocks(),
    });
    this.#frameBuilder = new FrameBuilder({
      state: this.state,
      transcript: this.#transcript,
      projectRoot: this.projectRoot,
      provider: this.provider,
      model: this.model,
      effort: this.effort,
      theme: this.theme,
    });
    if (options.driver) {
      const editorFactory = options.editorFactory ?? (() => new EditorState());
      const decoderFactory =
        options.decoderFactory ?? ((hooks) => new TerminalInputDecoder(hooks));
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

  select(request: SelectionRequest): Promise<string | null> {
    return this.#loop?.openSelection(request) ?? Promise.resolve(null);
  }

  prompt(request: PromptRequest): Promise<string | null>;
  prompt(message: string): Promise<string>;
  prompt(request: PromptRequest | string): Promise<string | null> {
    const normalized: PromptRequest = typeof request === "string"
      ? { id: "legacy-text-prompt", kind: "text", message: request }
      : request;
    if (this.#loop !== null && this.#loop.running) {
      return this.#loop.openPrompt(normalized);
    }
    if (this.#askFallback !== null && normalized.kind !== "select") {
      return this.#askFallback(normalized.message, normalized.kind === "secret");
    }
    return Promise.reject(
      new Error("interactive prompt requires a running terminal loop"),
    );
  }

  promptSecret(message: string): Promise<string> {
    return this.prompt({
      id: "legacy-secret-prompt",
      kind: "secret",
      message,
    }).then((value) => value ?? "");
  }

  // -- loop lifecycle -----------------------------------------------------

  /** Run the single-owner interactive terminal for the whole session. */
  async run(onSubmit: SubmitCallback): Promise<void> {
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

  startLoop(onSubmit: SubmitCallback): void {
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

  focusedComponentId(): string {
    return this.#loop?.focusedComponentId() ?? COMPOSER_COMPONENT;
  }

  // -- callbacks ----------------------------------------------------------

  setCommandRegistry(registry: CommandRegistryLike): void {
    this.commandRegistry = registry;
  }

  setCancelCallback(callback: () => void): void {
    this.cancelCallback = callback;
  }

  setRuntimeRunningCallback(callback: () => boolean): void {
    this.runtimeRunningCallback = callback;
  }

  setRuntimeCapabilities(capabilities: Partial<RuntimeCapabilities>): void {
    Object.assign(this.capabilities as MutableRuntimeCapabilities, capabilities);
  }

  setSessionId(sessionId: string): void {
    this.#sessionId = sessionId;
    this.#loop?.requestRender();
  }

  replaceTranscript(items: readonly RestoredTranscriptItemLike[]): void {
    this.#transcript.replace(items);
    this.#transcriptView.invalidate();
    this.#loop?.requestRender();
  }

  setComposerText(text: string): void {
    const editor = this.#loop?.editor;
    if (editor === undefined) {
      return;
    }
    editor.text = text;
    editor.cursor = text.length;
    editor.setCompletions([]);
    this.#loop?.requestRender();
  }

  setKeyActionCallback(
    callback: (action: Exclude<ActionId, "editor_newline" | "steer_now" | "submit_follow_up" | "dismiss" | "cancel">) => void,
  ): void {
    this.#keyActionCallback = callback;
  }

  handleKeyAction(action: Exclude<ActionId, "editor_newline" | "steer_now" | "submit_follow_up" | "dismiss" | "cancel">): void {
    if (this.#keyActionCallback === null) {
      this.write(`Key action is unavailable: ${action}.`);
      return;
    }
    this.#keyActionCallback(action);
  }

  toggleToolOutputFromKeybinding(): void {
    this.applyDisplayAction({
      type: "toggle_tool_output",
      expanded: !this.#transcript.toolOutputExpanded(),
    });
  }

  toggleReasoningFromKeybinding(): void {
    this.applyDisplayAction({
      type: "toggle_reasoning",
      visible: !this.#showReasoning,
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
    this.appendTranscript(createNoticeBlock(this.newBlockId(), displayGapMessage(dropped), "warning"));
    return true;
  }

  cancelFromKeybinding(): void {
    if (this.state.sessionState === "CANCELLING") {
      this.write("Cancelling…");
      return;
    }
    this.cancelCallback?.();
  }

  // -- transcript ---------------------------------------------------------

  newBlockId(): string {
    return this.#transcript.newBlockId();
  }

  appendTranscript(block: TranscriptBlock): void {
    this.#transcript.append(block);
    this.#loop?.requestRender();
  }

  acceptUserInput(text: string): void {
    this.appendTranscript(createUserBlock(this.newBlockId(), text));
  }

  blockFor(kind: string, key: string): TranscriptBlock {
    return this.#transcript.blockFor(kind, key);
  }

  /** Build every persisted transcript line; never crop history here. */
  buildHistoryLines(width: number): string[] {
    return this.#buildHistoryFrameParts(width).lines;
  }

  #buildHistoryFrameParts(width: number): { lines: string[]; activeStart: number | null } {
    const rendered = this.#transcriptView.renderWithMetadata({ width, theme: this.theme });
    return {
      lines: compileStyledLines(rendered.lines, Math.max(12, width), this.theme),
      activeStart: rendered.activeStart,
    };
  }

  buildFrame(options: {
    width: number;
    editor: EditorLike;
    prompt?: string;
    secret?: boolean;
  }): ScreenFrame {
    const { width, editor } = options;
    const contentWidth = Math.max(1, width - 1);
    const activeView = this.#loop?.renderActiveView({
      width: contentWidth,
      theme: this.theme,
    });
    const rendered = new MainScreen({
      transcript: this.#transcriptView,
      composer: new Composer({
        editor,
        prompt: options.prompt ?? "> ",
        mask: options.secret ?? false,
      }),
      activeView: activeView !== undefined && activeView.lines.length > 0
        ? activeView
        : null,
      completion: new CompletionPopup({
        items: editor.completions,
        selectedIndex: editor.selectedCompletion,
      }),
      status: new StatusLine({
        state: this.state,
        cwd: this.projectRoot,
        provider: this.provider,
        model: this.model,
        effort: this.effort,
      }),
    }).renderWithMetadata({ width: contentWidth, theme: this.theme });
    const lines = compileStyledLines(
      rendered.lines.map((line) => truncateStyledLine(line, contentWidth, "")),
      contentWidth,
      this.theme,
    );
    return this.#frameBuilder.build({
      ...options,
      compiledMainScreen: {
        lines,
        cursor: rendered.cursor ?? { row: 0, column: 0 },
        activeStart: rendered.activeStart,
      },
    }).screen;
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
        createNoticeBlock(this.newBlockId(), event.text, event.tone),
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
    if (action.type === "toggle_tool_output") {
      this.#transcript.setToolOutputExpanded(action.expanded);
    } else if (action.type === "toggle_reasoning") {
      this.#showReasoning = action.visible;
      this.#displayPolicy = new DisplayPolicy({
        audience: "terminal",
        foldToolOutput: false,
        showReasoning: this.#showReasoning,
      });
    } else {
      return;
    }
    this.#loop?.requestRender();
  }

  #applyDisplayEvent(event: DisplayEvent): void {
    if (event.kind === "display.gap") {
      this.appendTranscript(createNoticeBlock(this.newBlockId(), event.text, "warning"));
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
    this.#writeLocal(`Error: ${message}`, "error");
  }

  showInterrupted(options: { operation?: boolean } = {}): void {
    const message = options.operation ? "Operation interrupted." : "Interrupted.";
    this.#writeLocal(message, "warning");
  }

  showGoodbye(): void {
    if (this.#loop !== null) {
      if (!this.#loop.closed) {
        this.#writeLocal("Goodbye.", "dim");
        this.flushEventRenderer();
      }
      return;
    }
    this.#writeLocal("Goodbye.", "dim");
  }

  showAssistant(response: string): void {
    if (this.#loop !== null) {
      this.appendTranscript(
        createAssistantBlock(this.newBlockId(), response, false),
      );
      return;
    }
    for (const line of renderMarkdownLines(response, resolveFallbackMarkdownWidth(), this.theme)) {
      this.#output(line);
    }
  }

  showWelcome(): void {
    const details = [
      WELCOME_HELP_TEXT,
      `Directory: ${this.projectRoot ?? process.cwd()}`,
      `Session: ${this.#sessionId ?? "pending"}`,
      `Model: ${this.provider && this.model ? `${this.provider}/${this.model}` : "unconfigured"}`,
      `Version: ${this.#version}`,
    ];
    if (this.#loop !== null) {
      this.appendTranscript(
        createWelcomeBlock(WELCOME_TEXT, details),
      );
      return;
    }
    this.#output(
      ansiStyledText(`bold ${this.theme.color("accent")}`, WELCOME_TEXT) +
        "  " +
        ansiStyledText(this.theme.color("dim"), WELCOME_HELP_TEXT),
    );
    this.#output(ansiStyledText(this.theme.color("dim"), details.slice(1).join(" · ")));
  }

  #writeLocal(message: string, tone: NoticeTone = "info"): void {
    if (this.#loop !== null) {
      if (!this.#loop.closed) {
        this.#loop.publishEvent(new LocalMessage(message, tone));
        return;
      }
      this.#output(ansiStyledText(ansiNoticeStyle(this.theme, tone), message));
      return;
    }
    this.#output(ansiStyledText(ansiNoticeStyle(this.theme, tone), message));
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
    } else if (kind === "model.retry_scheduled") {
      this.outputFn(
        `Model request retry ${String(payload.attempt)}/` +
          `${String(payload.max_attempts)} in ` +
          `${String(payload.delay_ms)}ms ` +
          `(${String(payload.error_kind)}).`,
      );
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

  onResize(callback: () => void): () => void {
    process.stdout.on("resize", callback);
    return () => {
      process.stdout.off("resize", callback);
    };
  }

  restore(): void {
    if (this.#rawModeActive) {
      process.stdin.setRawMode(false);
      this.#rawModeActive = false;
    }
  }
}
