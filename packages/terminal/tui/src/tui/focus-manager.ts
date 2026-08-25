import type { OverlayManager } from "./overlay-manager.ts";

/** Routes keyboard focus to the top overlay, or back to the base component. */
export class FocusManager {
  #overlays: OverlayManager;
  #baseComponent: string;

  constructor(overlays: OverlayManager, baseComponent: string) {
    this.#overlays = overlays;
    this.#baseComponent = baseComponent;
  }

  current(): string {
    return this.#overlays.top()?.id ?? this.#baseComponent;
  }
}
