import type { LegacyTuiComponent } from "../component.ts";
import { truncateToWidth } from "../screen.ts";
import type { CompletionItemLike } from "../contracts.ts";
import type { TerminalTheme } from "../theme.ts";

export interface CompletionListOptions {
  readonly items: readonly CompletionItemLike[];
  readonly selectedIndex: number | null;
  readonly maxRows?: number;
  readonly theme?: TerminalTheme;
}

/** Width-bounded slash-command completion menu. */
export class CompletionList implements LegacyTuiComponent {
  focused = false;
  readonly #items: readonly CompletionItemLike[];
  readonly #selectedIndex: number | null;
  readonly #maxRows: number;
  readonly #theme: TerminalTheme | null;

  constructor(options: CompletionListOptions) {
    this.#items = options.items;
    this.#selectedIndex = options.selectedIndex;
    this.#maxRows = options.maxRows ?? 6;
    this.#theme = options.theme ?? null;
  }

  render(width: number): readonly string[] {
    return this.#items.slice(0, this.#maxRows).map((item, index) => {
      const selected = index === this.#selectedIndex;
      const marker = selected ? "›" : " ";
      const value = `${marker} ${item.value}`;
      const description = item.description.replace(/[\r\n]+/gu, " ").trim();
      const raw = description ? `${value}  ${description}` : value;
      if (this.#theme === null) {
        return truncateToWidth(raw, width);
      }
      if (selected) {
        return truncateToWidth(
          `${this.#theme.sgr("accent")}${raw}\x1b[0m`,
          width,
        );
      }
      const descriptionText = description
        ? `${this.#theme.sgr("muted")}  ${description}\x1b[0m`
        : "";
      return truncateToWidth(
        `${value}${descriptionText}`,
        width,
      );
    });
  }

  invalidate(): void {}
}
