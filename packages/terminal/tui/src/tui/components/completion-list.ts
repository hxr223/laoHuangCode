import type { FocusableComponent } from "../component.ts";
import type { CompletionItemLike } from "../contracts.ts";
import { charCellWidth } from "../screen.ts";
import {
  line,
  lineText,
  span,
  truncateStyledLine,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
} from "../render-model.ts";

export interface CompletionPopupOptions {
  readonly items: readonly CompletionItemLike[];
  readonly selectedIndex: number | null;
  readonly maxRows?: number;
}

/** Structured, actual-height slash-command completion menu. */
export class CompletionPopup implements FocusableComponent {
  focused = false;
  readonly #items: readonly CompletionItemLike[];
  readonly #selectedIndex: number | null;
  readonly #maxRows: number;

  constructor(options: CompletionPopupOptions) {
    this.#items = options.items;
    this.#selectedIndex = options.selectedIndex;
    this.#maxRows = options.maxRows ?? 6;
  }

  render(context: RenderContext): ComponentRenderResult {
    return {
      lines: this.#items
        .slice(0, this.#maxRows)
        .map((item, index) => this.#renderItem(item, index, context.width)),
    };
  }

  invalidate(): void {}

  #renderItem(item: CompletionItemLike, index: number, width: number): StyledLine {
    const selected = index === this.#selectedIndex;
    const description = item.description.replace(/[\r\n]+/gu, " ").trim();
    const value = line(
      span(selected ? "› " : "  ", selected ? { foreground: "accent" } : undefined),
      span(item.value, selected ? { foreground: "accent" } : undefined),
      ...(description ? [span(`  ${description}`, { foreground: "muted" })] : []),
    );
    const boundedWidth = Math.max(1, width);
    return displayWidth(lineText(value)) <= boundedWidth
      ? value
      : truncateStyledLine(value, boundedWidth, "");
  }
}

export { CompletionPopup as CompletionList };
export type CompletionListOptions = CompletionPopupOptions;

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) width += charCellWidth(character);
  return width;
}
