import type { ToolSpec } from "../index.ts";

export const SEARCH_TOOL_NAME = "tool_search";
export const SEARCH_TOOL_SPEC: ToolSpec = {
  name: SEARCH_TOOL_NAME,
  description: "Search available deferred tools by keywords in their names, descriptions, sources, and parameters. query describes the capability you need; limit defaults to 8. Matching definitions are loaded for the next model request; then call the target tool directly. This tool does not execute matched tools. Already loaded tools are not loaded again. Try an exact tool name or different keywords if nothing matches.",
  parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 4096 }, limit: { type: "integer", minimum: 1, maximum: 20, default: 8 } }, required: ["query"], additionalProperties: false },
  promptGuidelines: [],
};
