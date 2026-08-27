import type { TuiComponent } from "../../component.ts";
import {
  plainLine,
  type ComponentRenderResult,
  type RenderContext,
} from "../../render-model.ts";

export interface VStackOptions {
  readonly children: readonly TuiComponent[];
  readonly gap?: number;
}

export class VStack implements TuiComponent {
  readonly #children: readonly TuiComponent[];
  readonly #gap: number;

  constructor(options: VStackOptions) {
    this.#children = options.children;
    this.#gap = options.gap ?? 0;
    if (!Number.isInteger(this.#gap) || this.#gap < 0) {
      throw new Error("gap must be a non-negative integer");
    }
  }

  render(context: RenderContext): ComponentRenderResult {
    const lines = [];
    for (const [index, child] of this.#children.entries()) {
      if (index > 0) {
        lines.push(...Array.from({ length: this.#gap }, () => plainLine("")));
      }
      lines.push(...child.render(context).lines);
    }
    return { lines };
  }

  invalidate(): void {
    for (const child of this.#children) {
      child.invalidate();
    }
  }
}
