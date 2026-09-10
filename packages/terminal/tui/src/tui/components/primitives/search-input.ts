import type { FocusableComponent } from "../../component.ts";
import { EditorState, InputActionKind, inputAction } from "../../editor.ts";
import type { TuiInputEvent } from "../../../keybindings/key-id.ts";
import { projectInput } from "../../terminal-text.ts";
import {
  line,
  span,
  type ComponentRenderResult,
  type RenderContext,
} from "../../render-model.ts";

const PROMPT = "❯ ";

export interface SearchInputOptions {
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly onChange?: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly onCancel?: () => void;
  readonly secret?: boolean;
}

export class SearchInput implements FocusableComponent {
  focused = false;
  readonly #editor = new EditorState();
  readonly #placeholder: string;
  readonly #onChange: ((value: string) => void) | undefined;
  readonly #onSubmit: ((value: string) => void) | undefined;
  readonly #onCancel: (() => void) | undefined;
  readonly #secret: boolean;

  constructor(options: SearchInputOptions = {}) {
    this.#editor.text = options.initialValue ?? "";
    this.#editor.cursor = this.#editor.text.length;
    this.#placeholder = options.placeholder ?? "";
    this.#onChange = options.onChange;
    this.#onSubmit = options.onSubmit;
    this.#onCancel = options.onCancel;
    this.#secret = options.secret ?? false;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(1, context.width);
    const empty = this.#editor.text.length === 0;
    const projection = projectInput(empty ? this.#placeholder : this.#editor.text, this.#editor.cursor, width, PROMPT, this.#secret && !empty);
    const lines = projection.rows.map((value, index) => line(
      span(index === 0 ? projection.prompt : " ".repeat(projection.promptWidth), index === 0 ? { foreground: "accent" } : undefined),
      span(this.#secret && !empty ? value.replace(/\*/g, "•") : value, empty ? { foreground: "muted" } : undefined),
    ));
    return {
      lines,
      ...(this.focused ? { cursor: { row: empty ? 0 : projection.cursorRow, column: empty ? projection.promptWidth : projection.cursorColumn } } : {}),
    };
  }

  handleInput(event: TuiInputEvent): boolean {
    if (!this.focused) {
      return false;
    }
    const action = actionFor(event);
    if (action === null) {
      return false;
    }
    if (event.type === "key" && event.key.id === "escape") {
      this.#editor.apply(action, { runtimeActive: false });
      this.#onCancel?.();
      return true;
    }
    const before = this.#editor.text;
    const effect = this.#editor.apply(action, { runtimeActive: false });
    if (effect.submit !== null) {
      this.#onSubmit?.(effect.submit);
    } else if (before !== this.#editor.text) {
      this.#onChange?.(this.#editor.text);
    }
    return true;
  }

  clear(): void {
    this.#editor.text = "";
    this.#editor.cursor = 0;
    this.#editor.historyIndex = null;
    this.#editor.setCompletions([]);
  }

  dispose(): void {
    this.clear();
    this.focused = false;
  }

  invalidate(): void {}
}

function actionFor(event: TuiInputEvent) {
  if (event.type === "text" || event.type === "paste") {
    return inputAction(InputActionKind.Insert, event.text);
  }
  switch (event.key.id) {
    case "left":
      return inputAction(InputActionKind.CursorLeft);
    case "right":
      return inputAction(InputActionKind.CursorRight);
    case "backspace":
      return inputAction(InputActionKind.Backspace);
    case "enter":
      return inputAction(InputActionKind.Submit);
    case "escape":
      return inputAction(InputActionKind.Dismiss);
    default:
      return null;
  }
}
