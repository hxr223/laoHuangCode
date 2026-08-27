import type { TuiInputEvent } from "../keybindings/key-id.ts";
import type { ComponentRenderResult, RenderContext } from "./render-model.ts";

/** Small render/input contract shared by visible terminal UI components. */
export interface TuiComponent {
  render(context: RenderContext): ComponentRenderResult;
  handleInput?(event: TuiInputEvent): boolean;
  invalidate(): void;
  dispose?(): void;
}

/** Temporary string-rendering contract for components pending migration. */
export interface LegacyTuiComponent {
  render(width: number): readonly string[];
  invalidate(): void;
}

/** Component that can be targeted by focus management. */
export interface FocusableComponent extends TuiComponent {
  focused: boolean;
}
