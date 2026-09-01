import type { TuiComponent } from "./component.ts";
import type { CompletionPopup } from "./components/completion-list.ts";
import type { Composer } from "./components/composer.ts";
import type { StatusLine } from "./components/status-line.ts";
import type { Transcript } from "./components/transcript.ts";
import {
  plainLine,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
} from "./render-model.ts";

export interface MainScreenOptions {
  readonly transcript: Transcript;
  readonly composer: Composer;
  readonly activeView?: ComponentRenderResult | null;
  readonly completion: CompletionPopup;
  readonly status: StatusLine;
}

export interface MainScreenRenderResult extends ComponentRenderResult {
  readonly activeStart: number;
}

/** Root composition for transcript, active dock, completion, and status. */
export class MainScreen implements TuiComponent {
  readonly #transcript: Transcript;
  readonly #composer: Composer;
  readonly #activeView: ComponentRenderResult | null;
  readonly #completion: CompletionPopup;
  readonly #status: StatusLine;

  constructor(options: MainScreenOptions) {
    this.#transcript = options.transcript;
    this.#composer = options.composer;
    this.#activeView = options.activeView ?? null;
    this.#completion = options.completion;
    this.#status = options.status;
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.renderWithMetadata(context);
  }

  renderWithMetadata(context: RenderContext): MainScreenRenderResult {
    const width = Math.max(1, context.width);
    const nextContext = { ...context, width };
    const transcript = this.#transcript.renderWithMetadata(nextContext);
    const dock = this.#activeView ?? this.#composer.render(nextContext);
    const completion = this.#activeView === null
      ? this.#completion.render(nextContext)
      : { lines: [] as readonly StyledLine[] };
    const status = this.#status.render(nextContext);
    const dockCursor = dock.cursor ?? {
      row: Math.max(0, dock.lines.length - 1),
      column: 0,
    };
    const dockGap = transcript.lines.length > 0 && dock.lines.length > 0
      ? [plainLine("")]
      : [];
    const contentLines = [
      ...transcript.lines,
      ...dockGap,
      ...dock.lines,
      ...completion.lines,
      ...status.lines,
    ];
    return {
      lines: contentLines,
      cursor: {
        row: transcript.lines.length + dockGap.length + dockCursor.row,
        column: Math.min(width - 1, dockCursor.column),
      },
      activeStart: transcript.activeStart ?? transcript.lines.length,
    };
  }

  invalidate(): void {
    this.#transcript.invalidate();
    this.#composer.invalidate();
    this.#completion.invalidate();
    this.#status.invalidate();
  }
}
