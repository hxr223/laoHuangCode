import type { TuiComponent } from "../../component.ts";
import { Box } from "../primitives/box.ts";
import { Text } from "../primitives/text.ts";
import type { ComponentRenderResult, RenderContext, StyledSpan, StyleToken } from "../../render-model.ts";

export interface ToolMessageOptions {
  readonly name: string;
  readonly subject: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly expanded: boolean;
  readonly key?: string;
}

export class ToolMessage implements TuiComponent {
  readonly #content: Box;

  constructor(options: ToolMessageOptions) {
    const tone = options.status === "running"
      ? { background: "tool_pending_bg" as const, title: "accent" as const }
      : options.status === "completed"
        ? { background: "tool_success_bg" as const, title: "success" as const }
        : { background: "tool_error_bg" as const, title: "warning" as const };
    const title: StyledSpan[] = [{ text: `● ${options.name || "tool"}`, style: { foreground: tone.title } }];
    if (options.subject) {
      title.push({
        text: `  ${clip(options.subject, 180)}`,
        style: options.subject.startsWith("$ ") ? { foreground: "bash" } : undefined,
      });
    }
    if (options.key) title.push({ text: `  [${options.key.slice(-8)}]` });
    const detail = options.status === "running" ? "Running…" : options.status;
    const metadata = [
      detail,
      options.exitCode === null ? "" : `exit ${options.exitCode}`,
      options.durationMs === null ? "" : `${options.durationMs}ms`,
    ].filter(Boolean).join(" · ");
    const output = options.expanded
      ? [options.stderr && clip(options.stderr, 1_200), options.stdout && clip(options.stdout, 1_200)]
        .filter(Boolean)
      : [];
    this.#content = new Box({
      background: tone.background as StyleToken,
      child: new Text({
        spans: [...title, { text: `\n${[metadata, ...output].join("\n")}` }],
      }),
    });
  }

  render(context: RenderContext): ComponentRenderResult {
    return this.#content.render(context);
  }

  invalidate(): void {
    this.#content.invalidate();
  }
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
