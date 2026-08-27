import type { TuiComponent } from "../../component.ts";
import {
  padStyledLine,
  span,
  wrapStyledSpans,
  type ComponentRenderResult,
  type RenderContext,
} from "../../render-model.ts";

export interface UserMessageOptions {
  readonly text: string;
}

export class UserMessage implements TuiComponent {
  readonly #text: string;

  constructor(options: UserMessageOptions) {
    this.#text = options.text;
  }

  render(context: RenderContext): ComponentRenderResult {
    const width = Math.max(3, context.width);
    const lines = wrapStyledSpans([
      span("✨ ", { foreground: "accent" }),
      span(this.#text),
    ], width);
    return {
      lines: lines.map((value) => padStyledLine(value, width)),
    };
  }

  invalidate(): void {}
}
