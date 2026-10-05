import { validateToolArguments, type Tool, type ToolCall as PiToolCall } from "@earendil-works/pi-ai";
import type { ToolArgumentValidator } from "@laohuang/tools";

export const validatePiToolArguments: ToolArgumentValidator = (spec, call, args) => {
  const tool: Tool = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as Tool["parameters"],
  };
  const toolCall: PiToolCall = {
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: args as PiToolCall["arguments"],
  };
  let validated: unknown;
  try {
    validated = validateToolArguments(tool, toolCall);
  } catch (error) {
    // SDK diagnostics include the complete input; keep only field-level errors.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split("\n\nReceived arguments:\n")[0]);
  }
  if (typeof validated !== "object" || validated === null || Array.isArray(validated)) {
    throw new Error("Validated tool arguments must be a JSON object");
  }
  return validated as Record<string, unknown>;
};
