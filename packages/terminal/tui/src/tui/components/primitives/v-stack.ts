import type { TuiComponent } from "../../component.ts";
import {
  plainLine,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
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
    const lines: StyledLine[] = [];
    let cursor: ComponentRenderResult["cursor"] | undefined;
    let rowOffset = 0;
    for (const [index, child] of this.#children.entries()) {
      if (index > 0) {
        const gaps = Array.from({ length: this.#gap }, () => plainLine(""));
        lines.push(...gaps);
        rowOffset += gaps.length;
      }
      const rendered = child.render(context);
      if (cursor === undefined && rendered.cursor !== undefined) {
        cursor = {
          row: rowOffset + rendered.cursor.row,
          column: rendered.cursor.column,
        };
      }
      lines.push(...rendered.lines);
      rowOffset += rendered.lines.length;
    }
    return {
      lines,
      ...(cursor === undefined ? {} : { cursor }),
    };
  }

  invalidate(): void {
    for (const child of this.#children) {
      child.invalidate();
    }
  }
}
