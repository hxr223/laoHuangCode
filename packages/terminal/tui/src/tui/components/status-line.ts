import type { TuiComponent } from "../component.ts";
import {
  line,
  lineText,
  span,
  truncateStyledLine,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
  type StyledSpan,
} from "../render-model.ts";
import { visibleWidth } from "../screen.ts";
import type { UIState } from "../state.ts";

export interface StatusLineOptions {
  readonly state: UIState;
  readonly cwd?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly effort?: string | null;
}

/** Responsive footer metadata without a surrounding frame. */
export class StatusLine implements TuiComponent {
  readonly #state: UIState;
  readonly #provider: string | null;
  readonly #model: string | null;
  readonly #effort: string | null;

  constructor(options: StatusLineOptions) {
    this.#state = options.state;
    this.#provider = options.provider ?? null;
    this.#model = options.model ?? null;
    this.#effort = options.effort ?? null;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(1, context.width);
    const queue = this.#state.pendingCount || this.#state.heldCount
      ? `queue ${this.#state.pendingCount} pending / ${this.#state.heldCount} held`
      : null;
    const contextUsage = contextUsageLabel(this.#state.contextTokens, this.#state.contextWindow);
    const right = this.#rightLine();
    let leftItems = [contextUsage, queue].filter((value): value is string => value !== null);

    if (!fits(leftItems, right, width) && queue !== null) {
      leftItems = leftItems.filter((value) => value !== queue);
    }

    const left = metadataLine(leftItems);
    if (lineText(left).length === 0 && lineText(right).length === 0) {
      return { lines: [] };
    }
    const clippedLeft = truncateStyledLine(left, width, "");
    const leftWidth = displayWidth(lineText(clippedLeft));
    const gap = leftWidth > 0 && lineText(right).length > 0 ? 1 : 0;
    const clippedRight = truncateStyledLine(
      right,
      Math.max(0, width - leftWidth - gap),
      "",
    );
    const rightWidth = displayWidth(lineText(clippedRight));
    const padding = rightWidth > 0 ? Math.max(gap, width - leftWidth - rightWidth) : 0;
    return {
      lines: [line(
        ...clippedLeft.spans,
        ...(rightWidth > 0 ? [span(" ".repeat(padding)), ...clippedRight.spans] : []),
      )],
    };
  }

  invalidate(): void {}

  #rightLine(): StyledLine {
    const model = this.#state.model || this.#model || "";
    const provider = this.#state.provider || this.#provider || "";
    const providerModel = model ? (provider ? `${provider}/${model}` : model) : provider;
    const spans: StyledSpan[] = [];
    if (providerModel) spans.push(span(providerModel));
    if (this.#effort) {
      if (spans.length > 0) spans.push(span(" · ", { foreground: "dim" }));
      spans.push(span(`effort ${this.#effort}`, { foreground: "dim" }));
    }
    return line(...spans);
  }
}

function contextUsageLabel(tokens: number | null, contextWindow: number): string | null {
  const window = normalizedCount(contextWindow);
  if (window <= 0) {
    return null;
  }
  if (tokens === null) return `context: ? (?/${formatCompactCount(window)})`;
  const used = normalizedCount(tokens);
  const ratio = Math.min(100, (used / window) * 100);
  const percent = ratio > 0 && ratio < 0.1 ? "<0.1" : formatScaled(ratio);
  return `context: ${percent}% (${formatCompactCount(used)}/${formatCompactCount(window)})`;
}

function normalizedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    return `${formatScaled(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${formatScaled(value / 1_000)}K`;
  }
  return String(value);
}

function formatScaled(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

function metadataLine(items: readonly string[]): StyledLine {
  return line(...items.flatMap((value, index) => [
    ...(index > 0 ? [span(" · ", { foreground: "dim" })] : []),
    span(value, { foreground: "dim" }),
  ]));
}

function fits(leftItems: readonly string[], right: StyledLine, width: number): boolean {
  const leftWidth = displayWidth(lineText(metadataLine(leftItems)));
  const rightWidth = displayWidth(lineText(right));
  return leftWidth + rightWidth + (leftWidth > 0 && rightWidth > 0 ? 1 : 0) <= width;
}

function displayWidth(value: string): number {
  return visibleWidth(value);
}
