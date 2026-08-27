import type { TuiComponent } from "../../component.ts";
import { renderMarkdownStyledLines } from "../../markdown.ts";
import type { ComponentRenderResult, RenderContext } from "../../render-model.ts";

export interface AssistantMessageOptions {
  readonly text: string;
}

export class AssistantMessage implements TuiComponent {
  readonly #text: string;

  constructor(options: AssistantMessageOptions) {
    this.#text = options.text;
  }

  render(context: RenderContext): ComponentRenderResult {
    return { lines: renderMarkdownStyledLines(this.#text, context.width) };
  }

  invalidate(): void {}
}
