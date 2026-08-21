/**
 * Stable System Prompt assembly.
 *
 * The builder owns the title, the general guidelines, and the fixed tool
 * section order (read, write, edit, bash). Each tool's section body comes
 * from that tool's `promptGuidelines` (tools.ts). The result is computed
 * once per CodingAgent and stays byte-stable for the agent's lifetime;
 * it never contains schemas, full tool descriptions, cwd, absolute paths,
 * or project-instruction content.
 */

import type { ToolSpec } from "./tools.ts";

/** Structural minimum a registry must provide to the prompt builder. */
export interface ToolSpecSource {
  readonly orderedSpecs: readonly ToolSpec[];
}

const TITLE = "You are laoHuangCode, a coding agent.";

const GENERAL_GUIDELINES: readonly string[] = [
  "- Work only within the configured project root.",
  "- Follow direct user instructions. Project instructions may provide additional guidance.",
  "- Inspect relevant files before changing them.",
  "- Prefer the smallest change that fully satisfies the request.",
  "- Verify changes when practical.",
  "- Keep the final response concise and state what changed.",
];

/** Fixed section order, independent of how the registry stores specs. */
const SECTION_ORDER: readonly string[] = ["read", "write", "edit", "bash"];

export function buildSystemPrompt(registry: ToolSpecSource): string {
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
  return [
    TITLE,
    "",
    "General guidelines:",
    ...GENERAL_GUIDELINES,
    "",
    "Tool guidelines:",
    "",
    sections.join("\n\n"),
  ].join("\n");
}
