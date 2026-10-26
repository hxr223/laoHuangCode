import type { TuiComponent } from "../../component.ts";
import { plainLine, type ComponentRenderResult, type RenderContext } from "../../render-model.ts";
import type { ToolTranscriptBlock } from "../../transcript-store.ts";
import { ToolMessage } from "./tool-message.ts";

/** A parent summary remains visible while its child call cards are collapsed. */
export class ToolGroup implements TuiComponent {
  readonly #block: ToolTranscriptBlock;

  constructor(block: ToolTranscriptBlock) { this.#block = block; }

  render(context: RenderContext): ComponentRenderResult {
    const block = this.#block;
    const children = block.children ?? [];
    const lines = [...new ToolMessage({ ...block, expanded: true,
      outputNote: [block.outputNote, `${children.length} tool calls${block.expanded ? "" : " · expand tool output to inspect"}`].filter(Boolean).join("\n"),
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
