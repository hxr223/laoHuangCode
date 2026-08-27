/** Terminal frame data assembly, separate from terminal paint mechanics. */

import { compileStyledLines } from "./ansi-renderer.ts";
import type { EditorLike } from "./contracts.ts";
import { CompletionPopup } from "./components/completion-list.ts";
import { Composer } from "./components/composer.ts";
import { StatusLine } from "./components/status-line.ts";
import {
  lineText,
  plainLine,
  wrapStyledSpans,
  type StyledLine,
} from "./render-model.ts";
import type { ScreenFrame } from "./screen.ts";
import { truncateToWidth, visibleWidth } from "./screen.ts";
import type { UIState } from "./state.ts";
import { resolveTerminalTheme, type TerminalTheme } from "./theme.ts";
import type { TranscriptBlock, TranscriptStore } from "./transcript-store.ts";

export interface FrameBuilderOptions {
  state: UIState;
  transcript: TranscriptStore;
  projectRoot?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  title?: string;
  theme?: TerminalTheme;
}

export interface CompiledMainScreen {
  readonly lines: readonly string[];
  readonly cursor: { readonly row: number; readonly column: number };
  readonly activeStart: number;
}

export interface BuildFrameOptions {
  width: number;
  editor: EditorLike;
  prompt?: string;
  secret?: boolean;
  compiledMainScreen?: CompiledMainScreen;
}

export interface DisplayFrame {
  readonly titleBar: string;
  readonly welcomeBlock: readonly string[];
  readonly statusBar: string;
  readonly cursor: { readonly row: number; readonly col: number };
  readonly screen: ScreenFrame;
}

/** Adapts compiled unframed main-screen lines to the renderer's screen contract. */
export class FrameBuilder {
  readonly #state: UIState;
  readonly #transcript: TranscriptStore;
  readonly #projectRoot: string | null;
  readonly #provider: string | null;
  readonly #model: string | null;
  readonly #effort: string | null;
  readonly #title: string;
  readonly #theme: TerminalTheme;

  constructor(options: FrameBuilderOptions) {
    this.#state = options.state;
    this.#transcript = options.transcript;
    this.#projectRoot = options.projectRoot ?? null;
    this.#provider = options.provider ?? null;
    this.#model = options.model ?? null;
    this.#effort = options.effort ?? null;
    this.#title = options.title ?? "laoHuang";
    this.#theme = options.theme ?? resolveTerminalTheme();
  }

  build(options: BuildFrameOptions): DisplayFrame {
    const terminalWidth = Math.max(1, options.width);
    const width = Math.max(1, terminalWidth - 1);
    const mainScreen = options.compiledMainScreen ?? this.#fallbackMainScreen(options, width);
    const lines = mainScreen.lines.map((value) =>
      visibleWidth(value) <= width ? value : truncateToWidth(value, width));
    const cursor = {
      row: Math.max(0, Math.min(mainScreen.cursor.row, Math.max(0, lines.length - 1))),
      col: Math.max(0, Math.min(mainScreen.cursor.column, width - 1)),
    };
    return {
      titleBar: this.#title,
      welcomeBlock: this.#welcomeBlock(),
      statusBar: this.statusBar(width),
      cursor,
      screen: {
        lines,
        activeStart: Math.max(0, Math.min(mainScreen.activeStart, lines.length)),
        cursorRow: cursor.row,
        cursorCol: cursor.col,
      },
    };
  }

  statusBar(width = 79): string {
    return this.#status().render({ width: Math.max(1, width), theme: this.#theme }).lines
      .map(lineText)
      .join("\n");
  }

  #fallbackMainScreen(options: BuildFrameOptions, width: number): CompiledMainScreen {
    const transcriptLines: StyledLine[] = [];
    let activeStart: number | null = null;
    for (const block of this.#transcript.blocks()) {
      if (block.mutable && activeStart === null) activeStart = transcriptLines.length;
      for (const row of fallbackText(block).split(/\r\n|\n|\r/u)) {
        transcriptLines.push(...wrapStyledSpans(plainLine(row).spans, width));
      }
    }
    const composer = new Composer({
      editor: options.editor,
      prompt: options.prompt ?? "❯ ",
      mask: options.secret ?? false,
    }).render({ width, theme: this.#theme });
    const completion = new CompletionPopup({
      items: options.editor.completions,
      selectedIndex: options.editor.selectedCompletion,
    }).render({ width, theme: this.#theme });
    const status = this.#status().render({ width, theme: this.#theme });
    const cursor = composer.cursor ?? { row: Math.max(0, composer.lines.length - 1), column: 0 };
    const lines = [...transcriptLines, ...composer.lines, ...completion.lines, ...status.lines];
    return {
      lines: compileStyledLines(lines, width, this.#theme),
      cursor: {
        row: transcriptLines.length + cursor.row,
        column: cursor.column,
      },
      activeStart: activeStart ?? transcriptLines.length,
    };
  }

  #status(): StatusLine {
    return new StatusLine({
      state: this.#state,
      cwd: this.#projectRoot,
      provider: this.#provider,
      model: this.#model,
      effort: this.#effort,
    });
  }

  #welcomeBlock(): string[] {
    return this.#transcript.blocks()
      .flatMap((block) => {
        if (block.kind === "welcome") return [block.title, ...block.details];
        if (block.kind === "notice" && block.key === "welcome") return [block.text];
        return [];
      });
  }
}

function fallbackText(block: TranscriptBlock): string {
  switch (block.kind) {
    case "user":
    case "assistant":
    case "thinking":
    case "notice":
      return block.text;
    case "tool":
      return [`● ${block.name}`, block.subject, block.status].filter(Boolean).join("  ");
    case "welcome":
      return [block.title, ...block.details].join("\n");
    case "help":
      return block.commands.map((command) =>
        `${command.usage}  ${command.description}`).join("\n");
    case "provider_list":
      return block.providers.map(providerFallbackText).join("\n");
    case "provider_detail":
      return [
        providerFallbackText(block.provider),
        `${block.provider.dynamicModels ? "dynamic" : "static"} models  ` +
          `${block.provider.modelCount} ${block.provider.modelCount === 1 ? "model" : "models"}`,
      ].join("\n");
    case "queue_status":
      return [
        `pending ${block.queue.pending}`,
        `pending tokens ${block.queue.pendingTokens}`,
        `held ${block.queue.held}`,
        `held tokens ${block.queue.heldTokens}`,
        `dead letters ${block.queue.deadLetters}`,
      ].join("  ");
    default:
      return assertNever(block);
  }
}

function providerFallbackText(provider: {
  readonly name: string;
  readonly available: boolean;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly source: string | null;
}): string {
  return [
    provider.name,
    provider.available ? "available" : "unavailable",
    provider.configured ? "configured" : "unconfigured",
    provider.verified ? "verified" : "unverified",
    provider.source ?? "",
  ].filter(Boolean).join("  ");
}

function assertNever(value: never): never {
  throw new Error(`unknown transcript block: ${String(value)}`);
}
