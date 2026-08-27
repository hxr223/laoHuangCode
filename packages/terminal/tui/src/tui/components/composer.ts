import type { TuiComponent } from "../component.ts";
import type { EditorLike } from "../contracts.ts";
import {
  line,
  padStyledLine,
  span,
  truncateStyledLine,
  type ComponentRenderResult,
  type RenderContext,
  type SpanStyle,
  type StyledLine,
} from "../render-model.ts";

export interface ComposerOptions {
  readonly editor: EditorLike;
  readonly prompt?: string;
  readonly mask?: boolean;
}

/** Structured projection of the existing editor state and cursor calculations. */
export class Composer implements TuiComponent {
  readonly #editor: EditorLike;
  readonly #prompt: string;
  readonly #mask: boolean;

  constructor(options: ComposerOptions) {
    this.#editor = options.editor;
    this.#prompt = options.prompt ?? "> ";
    this.#mask = options.mask ?? false;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(1, context.width);
    if (width < 4) {
      const rendered = this.#editor.renderStyledLines(width, {
        prompt: this.#prompt,
        mask: this.#mask,
      });
      return {
        lines: rendered.lines,
        cursor: {
          row: rendered.cursorRow,
          column: rendered.cursorColumn,
        },
      };
    }
    const innerWidth = width - 2;
    const rendered = this.#editor.renderStyledLines(innerWidth, {
      prompt: this.#prompt,
      mask: this.#mask,
    });
    const borderStyle: SpanStyle = { foreground: "dim" };
    const lines: StyledLine[] = [
      line(
        span("╭", borderStyle),
        span("─".repeat(innerWidth), borderStyle),
        span("╮", borderStyle),
      ),
      ...rendered.lines.map((value) =>
        line(
          span("│", borderStyle),
          ...padStyledLine(truncateStyledLine(value, innerWidth, ""), innerWidth).spans,
          span("│", borderStyle),
        )
      ),
      line(
        span("╰", borderStyle),
        span("─".repeat(innerWidth), borderStyle),
        span("╯", borderStyle),
      ),
    ];
    return {
      lines,
      cursor: {
        row: rendered.cursorRow + 1,
        column: rendered.cursorColumn + 1,
      },
    };
  }

  invalidate(): void {}
}
