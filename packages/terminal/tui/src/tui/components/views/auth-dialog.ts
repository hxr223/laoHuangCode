import type { FocusableComponent } from "../../component.ts";
import type { TuiInputEvent } from "../../../keybindings/key-id.ts";
import { span, type ComponentRenderResult, type RenderContext } from "../../render-model.ts";
import { Box } from "../primitives/box.ts";
import { SearchInput } from "../primitives/search-input.ts";
import { SelectList } from "../primitives/select-list.ts";
import { Text } from "../primitives/text.ts";
import { VStack } from "../primitives/v-stack.ts";
import type { PromptRequest } from "./contracts.ts";

export interface AuthDialogOptions {
  readonly request: PromptRequest;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

export class AuthDialog implements FocusableComponent {
  #focused = false;
  readonly #request: PromptRequest;
  readonly #onSubmit: (value: string) => void;
  readonly #onCancel: () => void;
  #input: SearchInput | null;
  #selectList: SelectList | null;

  constructor(options: AuthDialogOptions) {
    this.#request = options.request;
    this.#onSubmit = options.onSubmit;
    this.#onCancel = options.onCancel;
    this.#input = this.#request.kind === "select" ? null : this.#createInput();
    this.#selectList = this.#request.kind === "select"
      ? new SelectList({
        items: this.#request.items,
        onSelect: (item) => this.#complete(item.value),
        onCancel: this.#onCancel,
      })
      : null;
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
    const control = this.#input ?? this.#selectList;
    if (control === null) {
      throw new Error("auth dialog requires a control");
    }
    return new Box({
      child: new VStack({
        children: [
          new Text({ spans: [span("Authentication", { foreground: "accent" })] }),
          new Text({ text: this.#request.message }),
          control,
          new Text({ spans: [span("Enter to submit, Esc to cancel", { foreground: "dim" })] }),
        ],
        gap: 1,
      }),
      paddingX: 2,
      paddingY: 1,
      background: "card",
    }).render(context);
  }

  handleInput(event: TuiInputEvent): boolean {
    if (!this.#focused) {
      return false;
    }
    if (event.type === "key" && event.key.id === "ctrl_c") {
      this.#onCancel();
      return true;
    }
    return (this.#input ?? this.#selectList)?.handleInput(event) ?? false;
  }

  invalidate(): void {
    this.#input?.invalidate();
    this.#selectList?.invalidate();
  }

  #createInput(): SearchInput {
    if (this.#request.kind === "select") {
      throw new Error("select authentication requests do not use text input");
    }
    return new SearchInput({
      placeholder: this.#request.placeholder,
      secret: this.#request.kind === "secret",
      onSubmit: (value) => this.#complete(value),
      onCancel: this.#onCancel,
    });
  }

  #complete(value: string): void {
    if (this.#input !== null) {
      this.#input = this.#createInput();
      this.#syncFocus();
    }
    this.#onSubmit(value);
  }

  #syncFocus(): void {
    if (this.#input !== null) {
      this.#input.focused = this.#focused;
    }
    if (this.#selectList !== null) {
      this.#selectList.focused = this.#focused;
    }
  }
}
