import type { TuiComponent } from "../../component.ts";
import {
  line,
  padStyledLine,
  span,
  truncateStyledLine,
  wrapStyledSpans,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
  type StyledSpan,
  type StyleToken,
} from "../../render-model.ts";

export interface TextOptions {
  readonly text?: string;
  readonly spans?: readonly StyledSpan[];
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly background?: StyleToken;
}

export class Text implements TuiComponent {
  readonly #options: {
    readonly text: string;
    readonly spans: readonly StyledSpan[];
    readonly paddingX: number;
    readonly paddingY: number;
    readonly background?: StyleToken;
  };
  #cache: { readonly width: number; readonly source: string; readonly result: ComponentRenderResult } | null = null;

  constructor(options: TextOptions = {}) {
    const paddingX = normalizePadding(options.paddingX, "paddingX");
    const paddingY = normalizePadding(options.paddingY, "paddingY");
    this.#options = {
      text: options.text ?? "",
      spans: options.spans ?? [],
      paddingX,
      paddingY,
      background: options.background,
    };
  }

  render(context: RenderContext): ComponentRenderResult {
    const spans = this.#options.spans.length > 0
      ? this.#options.spans
      : [span(this.#options.text)];
    const source = spans.map((item) => item.text).join("");
    if (this.#cache?.width === context.width && this.#cache.source === source) {
      return this.#cache.result;
    }
    const paddingX = Math.min(this.#options.paddingX, Math.max(0, Math.floor((context.width - 1) / 2)));
    const contentWidth = Math.max(1, context.width - paddingX * 2);
    const wrapped = wrapStyledSpans(spans, contentWidth);
    const result = { lines: applyTextPadding(wrapped, context.width, { ...this.#options, paddingX }) };
    this.#cache = { width: context.width, source, result };
    return result;
  }

  invalidate(): void {
    this.#cache = null;
  }
}

function applyTextPadding(
  lines: readonly StyledLine[],
  width: number,
  options: Required<Pick<TextOptions, "paddingX" | "paddingY">>
    & Pick<TextOptions, "background">,
): readonly StyledLine[] {
  const targetWidth = Math.max(0, width);
  const blank = (): StyledLine =>
    line(span(" ".repeat(targetWidth), backgroundStyle(options.background)));
  const horizontalPadding = span(
    " ".repeat(options.paddingX),
    backgroundStyle(options.background),
  );
  const contentLines = lines.map((value) => {
    const contentSpans = options.background === undefined
      ? value.spans
      : value.spans.map((item) => span(item.text, {
        ...item.style,
        background: item.style?.background ?? options.background,
      }));
    const padded = truncateStyledLine(
      line(horizontalPadding, ...contentSpans, horizontalPadding),
      targetWidth,
      "",
    );
    return padStyledLine(padded, targetWidth, options.background);
  });
  return [
    ...Array.from({ length: options.paddingY }, blank),
    ...contentLines,
    ...Array.from({ length: options.paddingY }, blank),
  ];
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
