export type OverlayPriority = "completion" | "selector" | "modal";

export interface OverlayEntry {
  readonly id: string;
  readonly priority: OverlayPriority;
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
    this.close(entry.id);
    this.#entries.push(entry);
  }

  close(id: string): void {
    this.#entries = this.#entries.filter((entry) => entry.id !== id);
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
}
