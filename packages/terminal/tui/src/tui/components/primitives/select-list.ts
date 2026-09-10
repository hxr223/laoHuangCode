import type { FocusableComponent } from "../../component.ts";
import type { TuiInputEvent } from "../../../keybindings/key-id.ts";
import { visibleWidth } from "../../screen.ts";
import {
  line,
  lineText,
  span,
  truncateStyledLine,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
} from "../../render-model.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

export interface SelectItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface SelectListOptions {
  readonly items: readonly SelectItem[];
  readonly maxVisible?: number;
  readonly onSelect?: (item: SelectItem) => void;
  readonly onCancel?: () => void;
}

export class SelectList implements FocusableComponent {
  focused = false;
  #items: readonly SelectItem[];
  #filteredItems: readonly SelectItem[];
  #selectedIndex = 0;
  readonly #maxVisible: number;
  readonly #onSelect: ((item: SelectItem) => void) | undefined;
  readonly #onCancel: (() => void) | undefined;

  constructor(options: SelectListOptions) {
    this.#items = options.items;
    this.#filteredItems = options.items;
    this.#maxVisible = options.maxVisible ?? 5;
    this.#onSelect = options.onSelect;
    this.#onCancel = options.onCancel;
    if (!Number.isInteger(this.#maxVisible) || this.#maxVisible < 1) {
      throw new Error("maxVisible must be a positive integer");
    }
  }

  setItems(items: readonly SelectItem[]): void {
    const selectedValue = this.selectedItem()?.value;
    this.#items = items;
    this.#filteredItems = items;
    this.#selectedIndex = selectedValue === undefined
      ? 0
      : Math.max(0, items.findIndex((item) => item.value === selectedValue));
  }

  setFilter(filter: string): void {
    const normalized = filter.toLowerCase();
    this.#filteredItems = this.#items.filter((item) => item.value.toLowerCase().startsWith(normalized));
    this.#selectedIndex = 0;
  }

  setSelectedValue(value: string): void {
    const index = this.#filteredItems.findIndex((item) => item.value === value);
    if (index >= 0) {
      this.#selectedIndex = index;
    }
  }

  selectedItem(): SelectItem | null {
    return this.#filteredItems[this.#selectedIndex] ?? null;
  }

  render(context: RenderContext): ComponentRenderResult {
    if (this.#filteredItems.length === 0) {
      return { lines: [line(span("  No matching commands", { foreground: "muted" }))] };
    }
    const start = Math.max(
      0,
      Math.min(
        this.#selectedIndex - Math.floor(this.#maxVisible / 2),
        this.#filteredItems.length - this.#maxVisible,
      ),
    );
    const end = Math.min(start + this.#maxVisible, this.#filteredItems.length);
    const primaryColumnWidth = this.#primaryColumnWidth();
    const lines = this.#filteredItems
      .slice(start, end)
      .map((item, index) => this.#renderItem(item, start + index === this.#selectedIndex, context.width, primaryColumnWidth));
    if (start > 0 || end < this.#filteredItems.length) {
      lines.push(
        truncateStyledLine(
          line(span(`  (${this.#selectedIndex + 1}/${this.#filteredItems.length})`, { foreground: "muted" })),
          context.width,
          "",
        ),
      );
    }
    return { lines };
  }

  handleInput(event: TuiInputEvent): boolean {
    if (!this.focused || event.type !== "key") {
      return false;
    }
    if (event.key.id === "up" || event.key.id === "down") {
      if (this.#filteredItems.length === 0) {
        return true;
      }
      this.#selectedIndex = event.key.id === "up"
        ? (this.#selectedIndex + this.#filteredItems.length - 1) % this.#filteredItems.length
        : (this.#selectedIndex + 1) % this.#filteredItems.length;
      return true;
    }
    if (event.key.id === "enter") {
      const selected = this.selectedItem();
      if (selected !== null) {
        this.#onSelect?.(selected);
      }
      return true;
    }
    if (event.key.id === "escape" || event.key.id === "ctrl_c") {
      this.#onCancel?.();
      return true;
    }
    return false;
  }

  invalidate(): void {}

  #renderItem(
    item: SelectItem,
    selected: boolean,
    width: number,
    primaryColumnWidth: number,
  ): StyledLine {
    const prefix = selected
      ? span("→ ", { foreground: "accent" })
      : span("  ");
    const prefixWidth = displayWidth(prefix.text);
    const description = item.description === undefined ? undefined : normalizeDescription(item.description);
    if (description && width > 40) {
      const effectivePrimaryWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
      const label = truncateText(displayValue(item), Math.max(1, effectivePrimaryWidth - PRIMARY_COLUMN_GAP));
      const spacing = " ".repeat(Math.max(1, effectivePrimaryWidth - displayWidth(label)));
      const remainingWidth = width - prefixWidth - displayWidth(label) - displayWidth(spacing) - 2;
      if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
        return truncateStyledLine(
          line(
            prefix,
            span(label, selected ? { foreground: "accent" } : undefined),
            span(spacing),
            span(truncateText(description, remainingWidth), { foreground: "muted" }),
          ),
          width,
          "",
        );
      }
    }
    return truncateStyledLine(
      line(
        prefix,
        span(
          truncateText(displayValue(item), Math.max(1, width - prefixWidth - 2)),
          selected ? { foreground: "accent" } : undefined,
        ),
      ),
      width,
      "",
    );
  }

  #primaryColumnWidth(): number {
    const widest = this.#filteredItems.reduce(
      (value, item) => Math.max(value, displayWidth(displayValue(item)) + PRIMARY_COLUMN_GAP),
      0,
    );
    return Math.max(1, Math.min(DEFAULT_PRIMARY_COLUMN_WIDTH, Math.max(DEFAULT_PRIMARY_COLUMN_WIDTH, widest)));
  }
}

function displayValue(item: SelectItem): string {
  return item.label || item.value;
}

function normalizeDescription(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function truncateText(value: string, width: number): string {
  return lineText(truncateStyledLine(line(span(value)), width, ""));
}

function displayWidth(value: string): number {
  return visibleWidth(value);
}
