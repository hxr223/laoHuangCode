import type { FocusableComponent } from "./component.ts";
import { compileStyledLines } from "./ansi-renderer.ts";
import type { ScreenFrame } from "./screen.ts";
import type { TerminalTheme } from "./theme.ts";
import { sliceByColumn, TERMINAL_RESET } from "./terminal-text.ts";
import { truncateStyledLine } from "./render-model.ts";

export type OverlayPriority = "completion" | "selector" | "modal";

export interface FloatingOverlayOptions {
  readonly width?: number | `${number}%`;
  readonly maxHeight?: number;
  readonly row?: number;
  readonly column?: number;
  readonly visible?: (width: number, height: number) => boolean;
  readonly nonCapturing?: boolean;
}

export interface OverlayEntry {
  readonly id: string;
  readonly priority: OverlayPriority;
  readonly placement: "dock" | "floating";
  readonly options?: FloatingOverlayOptions;
  readonly component: FocusableComponent;
}

const PRIORITY_ORDER: Readonly<Record<OverlayPriority, number>> = {
  completion: 0,
  selector: 1,
  modal: 2,
};

/** Maintains the small priority stack for transient terminal UI surfaces. */
export class OverlayManager {
  #entries: OverlayEntry[] = [];
  #hidden = new Set<string>();
  #width = 80;
  #height = 24;

  setViewport(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#syncFocus();
  }

  setHidden(id: string, hidden: boolean): void {
    if (hidden) this.#hidden.add(id);
    else this.#hidden.delete(id);
    this.#syncFocus();
  }

  composite(frame: ScreenFrame, theme: TerminalTheme): ScreenFrame {
    const overlays = this.#entries.filter(entry => entry.placement === "floating" && this.#visible(entry))
      .sort((left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]);
    if (overlays.length === 0) return frame;
    const lines = [...frame.lines];
    while (lines.length < this.#height) lines.push("");
    const viewport = Math.max(0, lines.length - this.#height);
    let cursorRow = frame.cursorRow;
    let cursorCol = frame.cursorCol;
    for (const entry of overlays) {
      const options = entry.options ?? {};
      const requested = typeof options.width === "string"
        ? this.#width * Number.parseFloat(options.width) / 100 : options.width ?? Math.min(80, this.#width);
      const width = Math.max(1, Math.min(this.#width, Number.isFinite(requested) ? Math.floor(requested) : this.#width));
      const rendered = entry.component.render({ width, theme });
      const height = Math.max(0, Math.min(this.#height, options.maxHeight ?? this.#height, rendered.lines.length));
      if (height === 0) continue;
      const row = Math.max(0, Math.min(this.#height - height, Math.floor(options.row ?? (this.#height - height) / 2)));
      const column = Math.max(0, Math.min(this.#width - width, Math.floor(options.column ?? (this.#width - width) / 2)));
      const content = compileStyledLines(rendered.lines.slice(0, height).map(value => truncateStyledLine(value, width, "")), width, theme);
      for (let index = 0; index < height; index++) {
        const target = viewport + row + index;
        const before = sliceByColumn(lines[target]!, 0, column);
        const after = sliceByColumn(lines[target]!, column + width, this.#width - column - width);
        lines[target] = before + TERMINAL_RESET + sliceByColumn(content[index]!, 0, width) + TERMINAL_RESET + after;
      }
      if (entry.component.focused) {
        cursorRow = viewport + row + Math.max(0, Math.min(height - 1, rendered.cursor?.row ?? 0));
        cursorCol = column + Math.max(0, Math.min(width - 1, rendered.cursor?.column ?? 0));
      }
    }
    return { ...frame, lines, activeStart: Math.min(frame.activeStart ?? lines.length, viewport), cursorRow, cursorCol };
  }

  open(entry: OverlayEntry): void {
    for (const value of [entry.options?.row, entry.options?.column, entry.options?.maxHeight]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error("Overlay coordinates and height must be non-negative integers");
    }
    this.#hidden.delete(entry.id);
    const previous = this.#entries.filter((item) => item.id === entry.id);
    for (const item of previous) {
      item.component.focused = false;
    }
    this.#entries = this.#entries.filter((item) => item.id !== entry.id);
    this.#entries.push(entry);
    this.#syncFocus();
  }

  close(id: string): void {
    this.#hidden.delete(id);
    const closing = this.#entries.filter((entry) => entry.id === id);
    for (const entry of closing) {
      entry.component.focused = false;
    }
    this.#entries = this.#entries.filter((entry) => entry.id !== id);
    this.#syncFocus();
  }

  top(): OverlayEntry | null {
    let top: OverlayEntry | null = null;
    for (const entry of this.#entries) {
      if (!this.#visible(entry) || entry.options?.nonCapturing) continue;
      if (
        top === null ||
        PRIORITY_ORDER[entry.priority] >= PRIORITY_ORDER[top.priority]
      ) {
        top = entry;
      }
    }
    return top;
  }

  #syncFocus(): void {
    const top = this.top();
    for (const entry of this.#entries) {
      entry.component.focused = entry === top;
    }
  }

  #visible(entry: OverlayEntry): boolean {
    return !this.#hidden.has(entry.id) && (entry.options?.visible?.(this.#width, this.#height) ?? true);
  }
}
