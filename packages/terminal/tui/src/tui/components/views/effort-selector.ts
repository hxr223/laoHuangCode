import type { FocusableComponent } from "../../component.ts";
import type { TuiInputEvent } from "../../../keybindings/key-id.ts";
import { span, type ComponentRenderResult, type RenderContext } from "../../render-model.ts";
import { SelectList, type SelectItem } from "../primitives/select-list.ts";
import { Text } from "../primitives/text.ts";
import { VStack } from "../primitives/v-stack.ts";

export interface SelectionViewOptions {
  readonly title: string;
  readonly items: readonly SelectItem[];
  readonly currentValue?: string;
  readonly maxVisible?: number;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

class SelectionView implements FocusableComponent {
  #focused = false;
  readonly #title: string;
  readonly #selectList: SelectList;

  constructor(options: SelectionViewOptions) {
    this.#title = options.title;
    this.#selectList = new SelectList({
      items: options.items,
      maxVisible: options.maxVisible,
      onSelect: (item) => options.onSelect(item.value),
      onCancel: options.onCancel,
    });
    if (options.currentValue !== undefined) {
      this.#selectList.setSelectedValue(options.currentValue);
    }
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
    return new VStack({
      children: [
        new Text({ spans: [span(this.#title, { foreground: "accent" })] }),
        this.#selectList,
      ],
      gap: 1,
    }).render(context);
  }

  handleInput(event: TuiInputEvent): boolean {
    return this.#selectList.handleInput(event);
  }

  invalidate(): void {
    this.#selectList.invalidate();
  }

  #syncFocus(): void {
    this.#selectList.focused = this.#focused;
  }
}

export class EffortSelectorView extends SelectionView {}

export class ProviderSelectorView extends SelectionView {}
