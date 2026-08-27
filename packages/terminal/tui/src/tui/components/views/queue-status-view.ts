import type { TuiComponent } from "../../component.ts";
import {
  line,
  span,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
} from "../../render-model.ts";
import type { QueueStatusViewModel } from "./contracts.ts";

export interface QueueStatusViewOptions extends QueueStatusViewModel {}

export class QueueStatusView implements TuiComponent {
  readonly #queue: QueueStatusViewModel;

  constructor(options: QueueStatusViewOptions) {
    this.#queue = options;
  }

  render(context: RenderContext): ComponentRenderResult {
    const counters = [
      ["pending", this.#queue.pending],
      ["pending tokens", this.#queue.pendingTokens],
      ["held", this.#queue.held],
      ["held tokens", this.#queue.heldTokens],
      ["dead letters", this.#queue.deadLetters],
    ] as const;
    if (context.width < 50) {
      return { lines: counters.map(([label, value]) => counterLine(label, value)) };
    }
    const spans = counters.flatMap(([label, value], index) => [
      ...(index === 0 ? [] : [span("  ")]),
      span(label, { foreground: "muted" }),
      span("  "),
      span(String(value)),
    ]);
    return { lines: [line(...spans)] };
  }

  invalidate(): void {}
}

function counterLine(label: string, value: number): StyledLine {
  return line(span(label, { foreground: "muted" }), span("  "), span(String(value)));
}
