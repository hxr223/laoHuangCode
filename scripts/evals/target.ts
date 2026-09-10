import { randomUUID } from "node:crypto";
import type { ProviderResponse } from "promptfoo";
import type { RunEvidence, Scenario } from "./types.ts";

/** Input adapter only: never inserts an answer or an assertion. */
export function createTargetScenario(prompt: string, files: Record<string, string>): Scenario {
  if (!prompt.trim()) throw new Error("Official test prompt is empty");
  return {
    id: `official-${randomUUID()}`, category: "安全与抗注入",
    label: "promptfoo official generated task", files: { ...files },
    turns: [{ prompt }], checks: [],
  };
}

export function toProviderResponse(evidence: RunEvidence, changedFiles: Record<string, string | null> = {}): ProviderResponse {
  const items = evidence.tools.map((tool) => ({
    type: "command_execution",
    // Preserve actual native calls; do not fabricate shell execution for file tools.
    command: tool.name === "bash" ? String(tool.args.command ?? "") : `${tool.name} ${JSON.stringify(tool.args)}`,
    aggregated_output: JSON.stringify(tool.result ?? {}),
    exit_code: tool.result?.exit_code,
    status: tool.result?.ok === false ? "failed" : "completed",
  }));
  const failed = evidence.status !== "completed";
  return {
    // Changed artifacts are target-produced evidence, not a custom score.
    output: evidence.output + (Object.keys(changedFiles).length ?
      `\n\n[Harness: files changed by the target; null means deleted]\n${JSON.stringify(changedFiles)}` : ""),
    ...(failed ? { error: `Target ${evidence.status}: ${evidence.error ?? "did not complete"}` } : {}),
    raw: { finalResponse: evidence.output, items, changedFiles, boundaryEvents: evidence.events.filter((e) => e.kind === "eval.canary_access") },
    tokenUsage: {
      prompt: evidence.usage.inputTokens, completion: evidence.usage.outputTokens,
      cached: evidence.usage.cacheReadTokens,
      total: evidence.usage.inputTokens + evidence.usage.outputTokens + evidence.usage.cacheReadTokens + evidence.usage.cacheWriteTokens,
    },
    metadata: { artifacts: evidence.artifacts, status: evidence.status, mode: evidence.mode,
      modelRequests: evidence.modelRequests, missingUsage: evidence.usage.missingRequests,
      grading: "promptfoo official plugin; no harness pass/fail score" },
    cached: false,
  };
}
