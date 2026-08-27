import type { TuiComponent } from "../../component.ts";
import { Text } from "../primitives/text.ts";
import type { ComponentRenderResult, RenderContext, StyleToken } from "../../render-model.ts";
import type { NoticeTone } from "../../transcript-store.ts";

export interface NoticeMessageOptions {
  readonly text: string;
  readonly tone: NoticeTone;
}

export class NoticeMessage implements TuiComponent {
  readonly #text: Text;

  constructor(options: NoticeMessageOptions) {
    this.#text = new Text({
      spans: [{ text: options.text, style: { foreground: foregroundFor(options.tone) } }],
    });
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#text.render(context);
  }

  invalidate(): void {
    this.#text.invalidate();
  }
}

function foregroundFor(tone: NoticeTone): StyleToken {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "error") return "error";
  if (tone === "dim") return "dim";
  return "accent";
}
