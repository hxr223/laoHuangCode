import type { TuiInputEvent } from "../keybindings/key-id.ts";

/** Small render/input contract shared by visible terminal UI components. */
export interface TuiComponent {
  render(width: number): readonly string[];
  handleInput?(event: TuiInputEvent): boolean;
  invalidate(): void;
}

/** Component that can be targeted by focus management. */
export interface FocusableComponent extends TuiComponent {
  focused: boolean;
}
