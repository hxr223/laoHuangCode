import type { TuiComponent } from "../../component.ts";
import { Text } from "../primitives/text.ts";
import type { ComponentRenderResult, RenderContext } from "../../render-model.ts";

export interface ThinkingMessageOptions {
  readonly text: string;
}

export class ThinkingMessage implements TuiComponent {
  readonly #text: Text;

  constructor(options: ThinkingMessageOptions) {
    this.#text = new Text({
      spans: [{ text: `thinking  ${options.text}`, style: { foreground: "thinking", italic: true } }],
    });
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#text.render(context);
  }

  invalidate(): void {
    this.#text.invalidate();
  }
}
