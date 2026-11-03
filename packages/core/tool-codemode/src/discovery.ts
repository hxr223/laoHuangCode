import { renderToolSample } from "@laohuang/codemode";
import { Bm25Index, toolSearchText, type ToolSpec } from "@laohuang/tools";

export function scriptCallableSpecs(tools: readonly ToolSpec[]): ToolSpec[] {
  return tools.filter(spec => spec.exposure !== "hidden" && spec.exposure !== "model-only" && spec.executionRole !== "orchestrator" &&
    spec.name !== "codemode" && spec.name !== "tool_search");
}

export function searchCodeModeTools(tools: readonly ToolSpec[], query: string, limit = 8): string {
  if (typeof query !== "string" || !query.trim()) throw new TypeError("searchTools query must be a non-empty string");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("searchTools limit must be a positive safe integer");
  const available = scriptCallableSpecs(tools);
  const index = new Bm25Index(available.map(spec => ({ name: spec.name, text: toolSearchText(spec) })));
  const byName = new Map(available.map(spec => [spec.name, spec]));
  const names = index.search(query, limit);
  if (!names.length) return "No matching script-callable tools. Use ALL_TOOLS to inspect the available names.";
  return names.map(name => {
    const spec = byName.get(name)!;
    return renderToolSample({ name: spec.name, description: spec.description, inputSchema: spec.parameters,
      outputSchema: spec.outputSchema ?? { type: "string" } });
  }).join("\n\n");
}
