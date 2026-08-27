import type { TuiComponent } from "../../component.ts";
import {
  line,
  span,
  type ComponentRenderResult,
  type RenderContext,
  type StyledLine,
} from "../../render-model.ts";
import type { HelpCommandViewModel } from "./contracts.ts";

export interface HelpViewOptions {
  readonly commands: readonly HelpCommandViewModel[];
}

export class HelpView implements TuiComponent {
  readonly #commands: readonly HelpCommandViewModel[];

  constructor(options: HelpViewOptions) {
    this.#commands = options.commands;
  }

  render(context: RenderContext): ComponentRenderResult {
    return { lines: this.#commands.flatMap((command) => this.#renderCommand(command, context.width)) };
  }

  invalidate(): void {}

  #renderCommand(command: HelpCommandViewModel, width: number): readonly StyledLine[] {
    if (width < 50) {
      return [line(span(command.usage)), line(span(command.description, { foreground: "muted" }))];
    }
    const usageWidth = Math.min(
      Math.max(1, width - 1),
      Math.max(...this.#commands.map((item) => item.usage.length), command.usage.length) + 2,
    );
    return [line(
      span(command.usage.padEnd(usageWidth)),
      span(command.description, { foreground: "muted" }),
    )];
  }
}
