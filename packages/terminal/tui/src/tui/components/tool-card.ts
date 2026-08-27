import type { TuiComponent } from "../component.ts";
import type { ComponentRenderResult, RenderContext } from "../render-model.ts";
import type { ToolTranscriptBlock } from "../transcript-store.ts";
import { ToolMessage } from "./messages/tool-message.ts";

export interface ToolCardOptions {
  readonly block: ToolTranscriptBlock;
}

/** Compatibility name for the structured tool transcript component. */
export class ToolCard implements TuiComponent {
  readonly #message: ToolMessage;

  constructor(options: ToolCardOptions) {
    this.#message = new ToolMessage(options.block);
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#message.render(context);
  }

  invalidate(): void {
    this.#message.invalidate();
  }
}
