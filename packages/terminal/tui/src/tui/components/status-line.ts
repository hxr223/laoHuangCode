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
import { charCellWidth } from "../screen.ts";
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
  readonly #cwd: string | null;
  readonly #provider: string | null;
  readonly #model: string | null;
  readonly #effort: string | null;

  constructor(options: StatusLineOptions) {
    this.#state = options.state;
    this.#cwd = options.cwd ?? null;
    this.#provider = options.provider ?? null;
    this.#model = options.model ?? null;
    this.#effort = options.effort ?? null;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(1, context.width);
    const queue = this.#state.pendingCount || this.#state.heldCount
      ? `queue ${this.#state.pendingCount} pending / ${this.#state.heldCount} held`
      : null;
    const tokens = this.#state.totalTokens
      ? `↑${this.#state.inputTokens} ↓${this.#state.outputTokens}`
      : null;
    const cwd = this.#cwd === null ? null : clippedCwd(this.#cwd);
    const right = this.#rightLine();
    let leftItems = [cwd, queue, tokens].filter((value): value is string => value !== null);

    if (!fits(leftItems, right, width) && cwd !== null) {
      leftItems = leftItems.filter((value) => value !== cwd);
    }
    if (!fits(leftItems, right, width) && tokens !== null) {
      leftItems = leftItems.filter((value) => value !== tokens);
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

function clippedCwd(path: string): string {
  return path.length <= 40 ? path : `…${path.slice(-39)}`;
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
  let width = 0;
  for (const character of value) width += charCellWidth(character);
  return width;
}
