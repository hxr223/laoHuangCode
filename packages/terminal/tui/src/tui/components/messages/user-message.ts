import type { TuiComponent } from "../../component.ts";
import { Text } from "../primitives/text.ts";
import type { ComponentRenderResult, RenderContext } from "../../render-model.ts";

export interface UserMessageOptions {
  readonly text: string;
}

export class UserMessage implements TuiComponent {
  readonly #text: Text;

  constructor(options: UserMessageOptions) {
    this.#text = new Text({ text: options.text, paddingX: 1, background: "user_bg" });
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#text.render(context);
  }

  invalidate(): void {
    this.#text.invalidate();
  }
}
