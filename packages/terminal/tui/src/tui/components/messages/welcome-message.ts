import type { TuiComponent } from "../../component.ts";
import {
  line,
  padStyledLine,
  span,
  truncateStyledLine,
  type ComponentRenderResult,
  type RenderContext,
  type SpanStyle,
  type StyledLine,
  type StyledSpan,
} from "../../render-model.ts";

export interface WelcomeMessageOptions {
  readonly title: string;
  readonly details: readonly string[];
}

export class WelcomeMessage implements TuiComponent {
  readonly #title: string;
  readonly #details: readonly string[];

  constructor(options: WelcomeMessageOptions) {
    this.#title = options.title;
    this.#details = options.details;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(1, context.width);
    if (width < 4) {
      return { lines: [line(span(this.#title, { foreground: "accent", bold: true }))] };
    }
    const innerWidth = width - 2;
    const borderStyle: SpanStyle = { foreground: "accent" };
    const lines: StyledLine[] = [
      line(
        span("╭", borderStyle),
        span("─".repeat(innerWidth), borderStyle),
        span("╮", borderStyle),
      ),
      frameRow(innerWidth, borderStyle, [
        span("H", { foreground: "accent", bold: true }),
        span("   "),
        span(this.#title, { foreground: "accent", bold: true }),
      ]),
    ];
    const [subtitle, ...meta] = this.#details;
    if (subtitle !== undefined) {
      lines.push(
        frameRow(innerWidth, borderStyle, [
          span("    "),
          span(subtitle, { foreground: "dim" }),
        ]),
      );
    }
    lines.push(frameRow(innerWidth, borderStyle, [span("")]));
    for (const detail of meta) {
      lines.push(frameRow(innerWidth, borderStyle, metaSpans(detail)));
    }
    lines.push(
      line(
        span("╰", borderStyle),
        span("─".repeat(innerWidth), borderStyle),
        span("╯", borderStyle),
      ),
    );
    return { lines };
  }

  invalidate(): void {}
}

function frameRow(
  innerWidth: number,
  borderStyle: SpanStyle,
  content: readonly StyledSpan[],
): StyledLine {
  const padded = padStyledLine(
    truncateStyledLine(line(...content), innerWidth, ""),
    innerWidth,
  );
  return line(span("│", borderStyle), ...padded.spans, span("│", borderStyle));
}

function metaSpans(detail: string): readonly StyledSpan[] {
  const match = /^([^:]+):(.*)$/u.exec(detail);
  if (match === null) {
    return [span(detail, { foreground: "dim" })];
  }
  return [
    span(`${match[1]}:`, { bold: true }),
    span(match[2] ?? ""),
  ];
}
