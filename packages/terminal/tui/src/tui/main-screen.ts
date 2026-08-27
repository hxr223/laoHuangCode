import type { TuiComponent } from "./component.ts";
import type { CompletionPopup } from "./components/completion-list.ts";
import type { Composer } from "./components/composer.ts";
import type { StatusLine } from "./components/status-line.ts";
import type { Transcript } from "./components/transcript.ts";
import type {
  ComponentRenderResult,
  RenderContext,
  StyledLine,
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

/** Unframed root composition for transcript, active dock, completion, and status. */
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
    const transcript = this.#transcript.renderWithMetadata(context);
    const dock = this.#activeView ?? this.#composer.render(context);
    const completion = this.#activeView === null
      ? this.#completion.render(context)
      : { lines: [] as readonly StyledLine[] };
    const status = this.#status.render(context);
    const dockCursor = dock.cursor ?? {
      row: Math.max(0, dock.lines.length - 1),
      column: 0,
    };
    return {
      lines: [
        ...transcript.lines,
        ...dock.lines,
        ...completion.lines,
        ...status.lines,
      ],
      cursor: {
        row: transcript.lines.length + dockCursor.row,
        column: dockCursor.column,
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
