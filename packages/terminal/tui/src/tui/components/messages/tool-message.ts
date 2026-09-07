import type { TuiComponent } from "../../component.ts";
import { Box } from "../primitives/box.ts";
import { Text } from "../primitives/text.ts";
import type { ComponentRenderResult, RenderContext, StyledSpan } from "../../render-model.ts";
import { redactToolText } from "../../display-policy.ts";

export interface ToolMessageOptions {
  readonly name: string;
  readonly subject: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly expanded: boolean;
  readonly outputNote?: string;
  readonly key?: string;
}

export class ToolMessage implements TuiComponent {
  readonly #content: Box;

  constructor(options: ToolMessageOptions) {
    const name = redactToolText(options.name);
    const subject = redactToolText(options.subject);
    const stdout = redactToolText(options.stdout);
    const stderr = redactToolText(options.stderr);
    const tone = options.status === "running"
      ? { title: "accent" as const }
      : options.status === "completed"
        ? { title: "success" as const }
        : { title: "warning" as const };
    const title: StyledSpan[] = [{ text: `● ${name || "tool"}`, style: { foreground: tone.title } }];
    if (subject) {
      title.push({
        text: `  ${clip(subject, 180)}`,
        style: subject.startsWith("$ ") ? { foreground: "bash" } : undefined,
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
      ? [stderr, stdout].filter(Boolean)
        .map((text) => text.length > 1200 ? `…${text.slice(-1200)}` : text)
      : [];
    this.#content = new Box({
      child: new Text({
        spans: [...title, { text: `\n${[metadata, ...output, options.outputNote && redactToolText(options.outputNote)].filter(Boolean).join("\n")}` }],
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
