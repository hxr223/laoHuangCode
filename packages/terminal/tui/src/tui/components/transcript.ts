import type { TuiComponent } from "../component.ts";
import { renderMarkdownLines } from "../markdown.ts";
import type { TerminalTheme } from "../theme.ts";
import type { TranscriptBlock } from "../transcript-store.ts";
import { styledBackgroundLines, styledPlainLines } from "./rendering.ts";
import { ToolCard } from "./tool-card.ts";

export interface TranscriptOptions {
  readonly blocks: readonly TranscriptBlock[];
  readonly theme: TerminalTheme;
}

export interface TranscriptRenderResult {
  readonly lines: readonly string[];
  readonly activeStart: number | null;
}

/** Renders append-only transcript blocks and reports the mutable region start. */
export class Transcript implements TuiComponent {
  readonly #blocks: readonly TranscriptBlock[];
  readonly #theme: TerminalTheme;

  constructor(options: TranscriptOptions) {
    this.#blocks = options.blocks;
    this.#theme = options.theme;
  }

  render(width: number): readonly string[] {
    return this.renderWithMetadata(width).lines;
  }

  renderWithMetadata(width: number): TranscriptRenderResult {
    const usableWidth = Math.max(12, width);
    const lines: string[] = [];
    let activeStart: number | null = null;
    for (const block of this.#blocks) {
      if (block.mutable && activeStart === null) {
        activeStart = lines.length;
      }
      lines.push(...this.#renderBlock(block, usableWidth));
    }
    return { lines, activeStart };
  }

  invalidate(): void {}

  #renderBlock(block: TranscriptBlock, width: number): readonly string[] {
    if (block.kind === "assistant") {
      return renderMarkdownLines(block.text, width, this.#theme);
    }
    if (block.kind === "user") {
      const style = `bg:${this.#theme.color("user_bg")} ${this.#theme.color("text")}`;
      return styledBackgroundLines(block.text, width, style);
    }
    if (block.kind === "thinking") {
      return styledPlainLines(
        `thinking  ${block.text}`,
        width,
        `italic ${this.#theme.color("thinking")}`,
      );
    }
    if (block.kind === "tool") {
      return new ToolCard({ block, theme: this.#theme }).render(width);
    }
    return styledPlainLines(block.text, width, block.style || this.#theme.color("text"));
  }
}
