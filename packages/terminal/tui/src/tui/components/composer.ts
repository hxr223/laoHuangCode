import type { TuiComponent } from "../component.ts";
import type { EditorLike } from "../contracts.ts";
import type { ComponentRenderResult, RenderContext } from "../render-model.ts";

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
    this.#prompt = options.prompt ?? "❯ ";
    this.#mask = options.mask ?? false;
  }

  render(context: RenderContext): ComponentRenderResult {
    const rendered = this.#editor.renderStyledLines(context.width, {
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

  invalidate(): void {}
}
