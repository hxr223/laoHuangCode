import type { TuiComponent } from "../component.ts";
import type { ComponentRenderResult, RenderContext, StyledLine } from "../render-model.ts";
import type { TranscriptBlock } from "../transcript-store.ts";
import { AssistantMessage } from "./messages/assistant-message.ts";
import { NoticeMessage } from "./messages/notice-message.ts";
import { ThinkingMessage } from "./messages/thinking-message.ts";
import { ToolMessage } from "./messages/tool-message.ts";
import { UserMessage } from "./messages/user-message.ts";
import { WelcomeMessage } from "./messages/welcome-message.ts";

export interface TranscriptOptions {
  readonly blocks: readonly TranscriptBlock[];
}

export interface TranscriptRenderResult {
  readonly lines: readonly StyledLine[];
  readonly activeStart: number | null;
}

/** Renders append-only transcript blocks and reports the mutable region start. */
export class Transcript implements TuiComponent {
  readonly #blocks: readonly TranscriptBlock[];

  constructor(options: TranscriptOptions) {
    this.#blocks = options.blocks;
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.renderWithMetadata(context);
  }

  renderWithMetadata(context: RenderContext): TranscriptRenderResult {
    const usableWidth = Math.max(12, context.width);
    const lines: StyledLine[] = [];
    let activeStart: number | null = null;
    for (const block of this.#blocks) {
      if (block.mutable && activeStart === null) activeStart = lines.length;
      lines.push(...this.#renderBlock(block, { ...context, width: usableWidth }));
    }
    return { lines, activeStart };
  }

  invalidate(): void {}

  #renderBlock(block: TranscriptBlock, context: RenderContext): readonly StyledLine[] {
    switch (block.kind) {
      case "assistant":
        return new AssistantMessage(block).render(context).lines;
      case "user":
        return new UserMessage(block).render(context).lines;
      case "thinking":
        return new ThinkingMessage(block).render(context).lines;
      case "tool":
        return new ToolMessage(block).render(context).lines;
      case "notice":
        return new NoticeMessage(block).render(context).lines;
      case "welcome":
        return new WelcomeMessage(block).render(context).lines;
      default:
        return assertNever(block);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown transcript block: ${String(value)}`);
}
