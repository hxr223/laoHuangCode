import type { TuiComponent } from "../../component.ts";
import { Text } from "../primitives/text.ts";
import { VStack } from "../primitives/v-stack.ts";
import type { ComponentRenderResult, RenderContext } from "../../render-model.ts";

export interface WelcomeMessageOptions {
  readonly title: string;
  readonly details: readonly string[];
}

export class WelcomeMessage implements TuiComponent {
  readonly #content: VStack;

  constructor(options: WelcomeMessageOptions) {
    this.#content = new VStack({
      children: [
        new Text({ spans: [{ text: options.title, style: { foreground: "accent", bold: true } }] }),
        ...options.details.map((detail) =>
          new Text({ spans: [{ text: detail, style: { foreground: "dim" } }] })),
      ],
    });
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#content.render(context);
  }

  invalidate(): void {
    this.#content.invalidate();
  }
}
