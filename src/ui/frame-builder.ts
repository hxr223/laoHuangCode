/** Terminal frame data assembly, separate from terminal paint mechanics. */

import type { EditorLike } from "../terminal/ui.ts";
import type { ScreenFrame } from "../terminal/screen.ts";
import { truncateToWidth } from "../terminal/screen.ts";
import type { UIState } from "../ui-state.ts";
import type { TranscriptStore } from "./transcript-store.ts";

export interface FrameBuilderOptions {
  state: UIState;
  transcript: TranscriptStore;
  projectRoot?: string | null;
  provider?: string | null;
  model?: string | null;
  title?: string;
}

export interface BuildFrameOptions {
  width: number;
  editor: EditorLike;
  prompt?: string;
  secret?: boolean;
  historyLines?: readonly string[];
  activeStart?: number | null;
  completionLines?: readonly string[];
}

export interface DisplayFrame {
  readonly titleBar: string;
  readonly welcomeBlock: readonly string[];
  readonly statusBar: string;
  readonly cursor: { readonly row: number; readonly col: number };
  readonly screen: ScreenFrame;
}

function clippedCwd(path: string): string {
  return path.length <= 40 ? path : `…${path.slice(-39)}`;
}

/** Builds frame data while leaving ANSI styling and terminal diffs to the renderer. */
export class FrameBuilder {
  readonly #state: UIState;
  readonly #transcript: TranscriptStore;
  readonly #projectRoot: string | null;
  readonly #provider: string | null;
  readonly #model: string | null;
  readonly #title: string;

  constructor(options: FrameBuilderOptions) {
    this.#state = options.state;
    this.#transcript = options.transcript;
    this.#projectRoot = options.projectRoot ?? null;
    this.#provider = options.provider ?? null;
    this.#model = options.model ?? null;
    this.#title = options.title ?? "laoHuangCode";
  }

  build(options: BuildFrameOptions): DisplayFrame {
    const width = Math.max(1, options.width);
    const editorResult = options.editor.renderLines(width, {
      prompt: options.prompt ?? "❯ ",
      mask: options.secret ?? false,
    });
    const history = options.historyLines ?? this.#fallbackHistory();
    const completion = options.completionLines ?? [];
    const statusBar = truncateToWidth(this.statusBar(), width);
    const rows = [
      ...history,
      "─".repeat(width),
      ...editorResult.lines,
      "─".repeat(width),
      ...completion,
      ...(statusBar ? [statusBar] : []),
    ];
    const editorStart = history.length + 1;
    const cursor = {
      row: editorStart + editorResult.cursorRow,
      col: editorResult.cursorCol,
    };
    return {
      titleBar: this.#title,
      welcomeBlock: this.#welcomeBlock(),
      statusBar,
      cursor,
      screen: {
        lines: rows,
        activeStart: options.activeStart ?? editorStart,
        cursorRow: cursor.row,
        cursorCol: cursor.col,
      },
    };
  }

  statusBar(): string {
    const details: string[] = [];
    if (this.#projectRoot !== null) {
      details.push(clippedCwd(this.#projectRoot));
    }
    if (this.#state.pendingCount || this.#state.heldCount) {
      details.push(`queue ${this.#state.pendingCount} pending / ${this.#state.heldCount} held`);
    }
    if (this.#state.totalTokens) {
      details.push(`↑${this.#state.inputTokens} ↓${this.#state.outputTokens}`);
    }
    const model = this.#state.model || this.#model || "";
    if (model) {
      const provider = this.#state.provider || this.#provider || "";
      details.push(provider ? `${provider}/${model}` : model);
    }
    return details.join(" · ");
  }

  #fallbackHistory(): string[] {
    return this.#transcript.blocks().flatMap((block) => block.text.split(/\r\n|\n|\r/));
  }

  #welcomeBlock(): string[] {
    return this.#transcript.blocks()
      .filter((block) => block.kind === "notice" && block.text.startsWith("laoHuangCode"))
      .map((block) => block.text);
  }
}
