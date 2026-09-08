import type { TuiComponent } from "../component.ts";
import { plainLine, type ComponentRenderResult, type RenderContext, type StyledLine } from "../render-model.ts";
import type { TranscriptBlock } from "../transcript-store.ts";
import { AssistantMessage } from "./messages/assistant-message.ts";
import { NoticeMessage } from "./messages/notice-message.ts";
import { ThinkingMessage } from "./messages/thinking-message.ts";
import { ToolMessage } from "./messages/tool-message.ts";
import { UserMessage } from "./messages/user-message.ts";
import { WelcomeMessage } from "./messages/welcome-message.ts";
import { HelpView } from "./views/help-view.ts";
import { ProviderDetailView, ProviderStatusView } from "./views/provider-status-view.ts";
import { QueueStatusView } from "./views/queue-status-view.ts";

export interface TranscriptOptions {
  readonly blocks: readonly TranscriptBlock[];
}

export interface TranscriptRenderResult {
  readonly lines: readonly StyledLine[];
  readonly activeStart: number | null;
}

interface CachedBlockRender {
  readonly block: TranscriptBlock;
  readonly component: TuiComponent;
  readonly width: number;
  readonly signature: string;
  readonly lines: readonly StyledLine[];
}

/** Renders append-only transcript blocks and reports the mutable region start. */
export class Transcript implements TuiComponent {
  readonly #blocks: readonly TranscriptBlock[];
  readonly #cache = new Map<string, CachedBlockRender>();

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
    const seenKeys = new Set<string>();
    for (const block of this.#blocks) {
      if (lines.length > 0) {
        lines.push(plainLine(""));
      }
      if (block.mutable && activeStart === null) activeStart = lines.length;
      seenKeys.add(cacheKey(block));
      lines.push(...this.#renderBlockCached(block, { ...context, width: usableWidth }));
    }
    for (const key of this.#cache.keys()) {
      if (!seenKeys.has(key)) this.#cache.delete(key);
    }
    return { lines, activeStart };
  }

  invalidate(): void {
    this.#cache.clear();
  }

  #renderBlockCached(block: TranscriptBlock, context: RenderContext): readonly StyledLine[] {
    const key = cacheKey(block);
    const signature = blockSignature(block);
    const cached = this.#cache.get(key);
    if (
      cached !== undefined &&
      cached.block === block &&
      cached.width === context.width &&
      cached.signature === signature
    ) {
      return cached.lines;
    }
    if (cached !== undefined && cached.block === block && cached.signature === signature) {
      const lines = cached.component.render(context).lines;
      this.#cache.set(key, {
        ...cached,
        width: context.width,
        lines,
      });
      return lines;
    }
    const component = this.#createBlockComponent(block);
    const lines = component.render(context).lines;
    this.#cache.set(key, {
      block,
      component,
      width: context.width,
      signature,
      lines,
    });
    return lines;
  }

  #createBlockComponent(block: TranscriptBlock): TuiComponent {
    switch (block.kind) {
      case "assistant":
        return new AssistantMessage(block);
      case "user":
        return new UserMessage(block);
      case "thinking":
        return new ThinkingMessage(block);
      case "tool":
        return new ToolMessage(block);
      case "notice":
        return new NoticeMessage(block);
      case "welcome":
        return new WelcomeMessage(block);
      case "help":
        return new HelpView(block);
      case "provider_list":
        return new ProviderStatusView(block);
      case "provider_detail":
        return new ProviderDetailView(block.provider);
      case "queue_status":
        return new QueueStatusView(block.queue);
      default:
        return assertNever(block);
    }
  }
}

function cacheKey(block: TranscriptBlock): string {
  return `${block.kind}:${block.key}`;
}

function blockSignature(block: TranscriptBlock): string {
  if (block.revision !== undefined) {
    return `revision:${block.revision}`;
  }
  return `content:${JSON.stringify(block)}`;
}

function assertNever(value: never): never {
  throw new Error(`unknown transcript block: ${String(value)}`);
}
