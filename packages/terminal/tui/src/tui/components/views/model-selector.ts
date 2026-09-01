import type { FocusableComponent } from "../../component.ts";
import type { TuiInputEvent } from "../../../keybindings/key-id.ts";
import type { ComponentRenderResult, RenderContext } from "../../render-model.ts";
import { span } from "../../render-model.ts";
import { SearchInput } from "../primitives/search-input.ts";
import { SelectList, type SelectItem } from "../primitives/select-list.ts";
import { Text } from "../primitives/text.ts";
import { VStack } from "../primitives/v-stack.ts";

export interface ModelSelectorViewOptions {
  readonly title: string;
  readonly items: readonly SelectItem[];
  readonly currentValue?: string;
  readonly searchPlaceholder?: string;
  readonly maxVisible?: number;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

export class ModelSelectorView implements FocusableComponent {
  #focused = false;
  #activeChild: "search" | "list" = "search";
  readonly #title: string;
  readonly #items: readonly SelectItem[];
  readonly #searchInput: SearchInput;
  readonly #selectList: SelectList;
  readonly #onCancel: () => void;

  constructor(options: ModelSelectorViewOptions) {
    this.#title = options.title;
    this.#items = options.items;
    this.#onCancel = options.onCancel;
    this.#selectList = new SelectList({
      items: options.items,
      maxVisible: options.maxVisible,
      onSelect: (item) => options.onSelect(item.value),
      onCancel: options.onCancel,
    });
    if (options.currentValue !== undefined) {
      this.#selectList.setSelectedValue(options.currentValue);
    }
    this.#searchInput = new SearchInput({
      placeholder: options.searchPlaceholder ?? "Search models",
      onChange: (value) => this.#filterModels(value),
    });
    this.#syncFocus();
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#syncFocus();
  }

  render(context: RenderContext): ComponentRenderResult {
    const selected = this.#selectList.selectedItem();
    const children = [
      new Text({ spans: [span(this.#title, { foreground: "accent" })] }),
      this.#searchInput,
      this.#selectList,
    ];
    if (selected?.description !== undefined) {
      children.push(new Text({ spans: [span(selected.description, { foreground: "muted" })] }));
    }
    return new VStack({ children, gap: 1 }).render(context);
  }

  handleInput(event: TuiInputEvent): boolean {
    if (!this.#focused) {
      return false;
    }
    if (event.type === "key" && (event.key.id === "escape" || event.key.id === "ctrl_c")) {
      this.#onCancel();
      return true;
    }
    if (event.type === "key" && (event.key.id === "up" || event.key.id === "down" || event.key.id === "enter")) {
      this.#activeChild = "list";
      this.#syncFocus();
      return this.#selectList.handleInput(event);
    }
    this.#activeChild = "search";
    this.#syncFocus();
    return this.#searchInput.handleInput(event);
  }

  invalidate(): void {
    this.#searchInput.invalidate();
    this.#selectList.invalidate();
  }

  #syncFocus(): void {
    this.#searchInput.focused = this.#focused && this.#activeChild === "search";
    this.#selectList.focused = this.#focused && this.#activeChild === "list";
  }

  #filterModels(value: string): void {
    const filter = value.toLowerCase();
    this.#selectList.setItems(this.#items.filter((item) =>
      item.value.toLowerCase().includes(filter) || item.label.toLowerCase().includes(filter),
    ));
  }
}
