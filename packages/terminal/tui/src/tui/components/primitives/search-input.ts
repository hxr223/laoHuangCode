import type { FocusableComponent } from "../../component.ts";
import { EditorState, InputActionKind, inputAction } from "../../editor.ts";
import type { TuiInputEvent } from "../../../keybindings/key-id.ts";
import { charCellWidth } from "../../screen.ts";
import {
  line,
  span,
  truncateStyledLine,
  wrapStyledSpans,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
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
    const contentWidth = Math.max(1, width - displayWidth(PROMPT));
    const displayText = this.#secret ? "•".repeat(this.#editor.text.length) : this.#editor.text;
    const lines = renderLines(displayText || this.#placeholder, contentWidth, displayText.length === 0 && this.#placeholder.length > 0);
    const structuredLines = lines.map((value, index) =>
      truncateStyledLine(
        line(
          span(index === 0 ? PROMPT : " ".repeat(displayWidth(PROMPT)), index === 0 ? { foreground: "accent" } : undefined),
          span(value, displayText.length === 0 && this.#placeholder.length > 0 ? { foreground: "muted" } : undefined),
        ),
        width,
        "",
      ),
    );
    const cursor = this.focused
      ? cursorMetadata(displayText.slice(0, this.#editor.cursor), contentWidth)
      : undefined;
    return cursor === undefined
      ? { lines: structuredLines }
      : {
        lines: structuredLines,
        cursor: {
          row: Math.min(cursor.row, structuredLines.length - 1),
          column: Math.min(displayWidth(PROMPT) + cursor.column, width - 1),
        },
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

function renderLines(value: string, width: number, placeholder: boolean): readonly string[] {
  if (placeholder) {
    return [value];
  }
  const lines: string[] = [];
  for (const source of value.split("\n")) {
    lines.push(...wrapStyledSpans([span(source)], width).map((item) => item.spans.map((part) => part.text).join("")));
  }
  const last = value.split("\n").at(-1) ?? "";
  if (value && !value.endsWith("\n") && displayWidth(last) % width === 0) {
    lines.push("");
  }
  return lines;
}

function cursorMetadata(before: string, width: number): { row: number; column: number } {
  const segments = before.split("\n");
  let row = 0;
  for (const segment of segments.slice(0, -1)) {
    row += wrappedRowCount(segment, width);
  }
  const current = segments.at(-1) ?? "";
  let column = 0;
  for (const character of current) {
    const characterWidth = Math.max(1, charCellWidth(character));
    if (column > 0 && column + characterWidth > width) {
      row += 1;
      column = 0;
    }
    column += characterWidth;
    if (column === width) {
      row += 1;
      column = 0;
    }
  }
  return { row, column };
}

function wrappedRowCount(value: string, width: number): number {
  return wrapStyledSpans([span(value)], width).length;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += charCellWidth(character);
  }
  return width;
}
