import type { TuiComponent } from "../../component.ts";
import { plainLine, type ComponentRenderResult, type RenderContext } from "../../render-model.ts";
import type { ToolTranscriptBlock } from "../../transcript-store.ts";
import { ToolMessage } from "./tool-message.ts";

/** Parent metadata stays visible; explicit output and child cards share the expansion state. */
export class ToolGroup implements TuiComponent {
  readonly #block: ToolTranscriptBlock;

  constructor(block: ToolTranscriptBlock) { this.#block = block; }

  render(context: RenderContext): ComponentRenderResult {
    const block = this.#block;
    const children = block.children ?? [];
    const lines = [...new ToolMessage({ ...block,
      outputNote: [block.expanded ? block.outputNote : block.outputNote?.split(/\r?\n/, 1)[0]?.slice(0, 160),
        `${children.length} tool calls${block.expanded ? "" : " · expand tool output to inspect"}`].filter(Boolean).join("\n"),
    }).render(context).lines];
    if (block.expanded) {
      for (const child of children) {
        lines.push(plainLine(""), ...new ToolMessage(child).render(context).lines);
      }
    }
    return { lines };
  }

  invalidate(): void {}
}
