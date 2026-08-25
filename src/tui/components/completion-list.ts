import type { FocusableComponent } from "../component.ts";
import { truncateToWidth } from "../screen.ts";
import type { CompletionItemLike } from "../ui.ts";

export interface CompletionListOptions {
  readonly items: readonly CompletionItemLike[];
  readonly selectedIndex: number | null;
  readonly maxRows?: number;
}

/** Width-bounded slash-command completion menu. */
export class CompletionList implements FocusableComponent {
  focused = false;
  readonly #items: readonly CompletionItemLike[];
  readonly #selectedIndex: number | null;
  readonly #maxRows: number;

  constructor(options: CompletionListOptions) {
    this.#items = options.items;
    this.#selectedIndex = options.selectedIndex;
    this.#maxRows = options.maxRows ?? 6;
  }

  render(width: number): readonly string[] {
    return this.#items.slice(0, this.#maxRows).map((item, index) => {
      const marker = index === this.#selectedIndex ? "›" : " ";
      const text = `${marker} ${item.value}  ${item.description}`.replace(/\s+$/u, "");
      return truncateToWidth(text, width);
    });
  }

  invalidate(): void {}
}
