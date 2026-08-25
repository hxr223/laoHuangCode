import type { TuiComponent } from "../component.ts";
import type { TerminalTheme } from "../theme.ts";
import type { TranscriptBlock } from "../transcript-store.ts";
import { clip, styledBackgroundLines } from "./rendering.ts";

export interface ToolCardOptions {
  readonly block: TranscriptBlock;
  readonly theme: TerminalTheme;
}

/** Render one tool transcript block as a compact status card. */
export class ToolCard implements TuiComponent {
  readonly #block: TranscriptBlock;
  readonly #theme: TerminalTheme;

  constructor(options: ToolCardOptions) {
    this.#block = options.block;
    this.#theme = options.theme;
  }

  render(width: number): readonly string[] {
    const item = this.#block;
    const status = item.status || "running";
    const isRunning = status === "running";
    const background = isRunning
      ? "tool_pending_bg"
      : status === "completed"
        ? "tool_success_bg"
        : "tool_error_bg";
    const accent = isRunning
      ? "accent"
      : status === "completed"
        ? "success"
        : "warning";
    let title = `● ${item.name || "tool"}`;
    if (item.subject) {
      title += `  ${clip(item.subject, 180)}`;
    }
    if (item.key) {
      title += `  [${item.key.slice(-8)}]`;
    }
    let detail = isRunning ? "Running…" : status;
    if (item.exitCode !== null) {
      detail += ` · exit ${item.exitCode}`;
    }
    if (item.durationMs !== null) {
      detail += ` · ${item.durationMs}ms`;
    }
    if (item.streamError) {
      detail += `\n${clip(item.streamError, 1_200)}`;
    }
    if (item.toolOutputExpanded && item.toolOutput) {
      detail += `\n${clip(item.toolOutput, 1_200)}`;
    }
    const textStyle = `bg:${this.#theme.color(background)} ${this.#theme.color("text")}`;
    const accentStyle = `bg:${this.#theme.color(background)} ${this.#theme.color(accent)}`;
    const rendered = styledBackgroundLines(`${title}\n${detail}`, width, textStyle);
    const first = rendered[0];
    if (first !== undefined) {
      rendered[0] = styledBackgroundLines(title, width, accentStyle)[0] ?? first;
    }
    return rendered;
  }

  invalidate(): void {}
}
