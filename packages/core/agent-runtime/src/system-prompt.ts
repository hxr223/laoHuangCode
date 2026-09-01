/**
 * Stable System Prompt assembly.
 *
 * The builder owns the title, the general guidelines, and the fixed tool
 * section order (read, write, edit, bash). Each tool's section body comes
 * from that tool's `promptGuidelines` (tools.ts). The result is computed
 * once per CodingAgent and stays byte-stable for the agent's lifetime.
 * It may include startup runtime facts such as the CLI version, selected model,
 * and cwd, but never contains schemas, full tool descriptions, or
 * project-instruction content.
 */

import type { ToolSpec } from "@laohuang/tools";

/** Structural minimum a registry must provide to the prompt builder. */
export interface ToolSpecSource {
  readonly orderedSpecs: readonly ToolSpec[];
}

export interface SystemPromptOptions {
  readonly cliName?: string | null;
  readonly cliVersion?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly promptCwd?: string | null;
}

const TITLE =
  "You are a coding agent operating inside LaoHuang, the laohuang CLI harness.";

const GENERAL_GUIDELINES: readonly string[] = [
  "- Follow direct user instructions. Project instructions may provide additional guidance.",
  "- Inspect relevant files before changing them.",
  "- Prefer the smallest change that fully satisfies the request.",
  "- Verify changes when practical.",
  "- Keep the final response concise and state what changed.",
];

/** Fixed section order, independent of how the registry stores specs. */
const SECTION_ORDER: readonly string[] = ["read", "write", "edit", "bash"];

export function buildSystemPrompt(
  registry: ToolSpecSource,
  options: SystemPromptOptions = {},
): string {
  const specsByName = new Map(
    registry.orderedSpecs.map((spec) => [spec.name, spec]),
  );
  const sections = SECTION_ORDER.map((name) => {
    const spec = specsByName.get(name);
    const body = (spec?.promptGuidelines ?? [])
      .map((guideline) => `- ${guideline}`)
      .join("\n");
    return `## ${name}\n${body}`;
  });
  const runtimeFacts = runtimeFactLines(options);
  return [
    TITLE,
    "",
    "General guidelines:",
    ...GENERAL_GUIDELINES,
    "",
    "Tool guidelines:",
    "",
    sections.join("\n\n"),
    ...(runtimeFacts.length === 0 ? [] : ["", "Runtime facts:", ...runtimeFacts]),
  ].join("\n");
}

function runtimeFactLines(options: SystemPromptOptions): string[] {
  const lines: string[] = [];
  if (hasText(options.cliName)) {
    lines.push(`- CLI: ${options.cliName}`);
  }
  if (hasText(options.cliVersion)) {
    lines.push(`- CLI version: ${options.cliVersion}`);
  }
  if (hasText(options.provider) && hasText(options.model)) {
    lines.push(`- Provider/model: ${options.provider}/${options.model}`);
  }
  if (hasText(options.promptCwd)) {
    lines.push(`- Current working directory: ${options.promptCwd}`);
  }
  return lines;
}

function hasText(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.length > 0;
}
