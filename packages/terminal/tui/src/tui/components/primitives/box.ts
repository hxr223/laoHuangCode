import type { TuiComponent } from "../../component.ts";
import {
  line,
  padStyledLine,
  span,
  truncateStyledLine,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
  type StyleToken,
} from "../../render-model.ts";

export interface BoxOptions {
  readonly child: TuiComponent;
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly background?: StyleToken;
}

export class Box implements TuiComponent {
  readonly #child: TuiComponent;
  readonly #paddingX: number;
  readonly #paddingY: number;
  readonly #background: StyleToken | undefined;

  constructor(options: BoxOptions) {
    this.#child = options.child;
    this.#paddingX = normalizePadding(options.paddingX, "paddingX");
    this.#paddingY = normalizePadding(options.paddingY, "paddingY");
    this.#background = options.background;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(0, context.width);
    const child = this.#child.render({ ...context, width: Math.max(1, width - this.#paddingX * 2) });
    if (child.lines.length === 0) {
      return { lines: [] };
    }
    const blank = (): StyledLine => line(span(" ".repeat(width), backgroundStyle(this.#background)));
    const lines = child.lines.map((value) => this.#renderLine(value, width));
    return {
      lines: [
        ...Array.from({ length: this.#paddingY }, blank),
        ...lines,
        ...Array.from({ length: this.#paddingY }, blank),
      ],
    };
  }

  invalidate(): void {
    this.#child.invalidate();
  }

  #renderLine(value: StyledLine, width: number): StyledLine {
    const left = span(" ".repeat(this.#paddingX), backgroundStyle(this.#background));
    const content = value.spans.map((item) =>
      span(item.text, this.#background === undefined ? item.style : { ...item.style, background: this.#background }),
    );
    return padStyledLine(
      truncateStyledLine(line(left, ...content), width, ""),
      width,
      this.#background,
    );
  }
}

function backgroundStyle(background: StyleToken | undefined) {
  return background === undefined ? undefined : { background };
}

function normalizePadding(value: number | undefined, name: string): number {
  const padding = value ?? 0;
  if (!Number.isInteger(padding) || padding < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return padding;
}
