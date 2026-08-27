import type { FocusableComponent } from "./component.ts";

export type OverlayPriority = "completion" | "selector" | "modal";

export interface OverlayEntry {
  readonly id: string;
  readonly priority: OverlayPriority;
  readonly placement: "dock";
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

  open(entry: OverlayEntry): void {
    const previous = this.#entries.filter((item) => item.id === entry.id);
    for (const item of previous) {
      item.component.focused = false;
    }
    this.#entries = this.#entries.filter((item) => item.id !== entry.id);
    this.#entries.push(entry);
    this.#syncFocus();
  }

  close(id: string): void {
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
}
