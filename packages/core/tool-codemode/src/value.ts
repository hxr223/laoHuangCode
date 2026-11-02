import { scriptOutputOf, type ToolResult, type ToolSpec } from "@laohuang/tools";

export class ToolScriptError extends Error {
  readonly toolName: string;
  readonly status: string;
  constructor(spec: ToolSpec, result: ToolResult) {
    const status = result.status || "failed";
    super(`Tool ${spec.name} ${status}${result.error ? `: ${result.error.slice(0, 4000)}` : ""}`);
    this.name = "ToolScriptError";
    this.toolName = spec.name;
    this.status = status;
  }
}

export function toScriptToolValue(spec: ToolSpec, result: ToolResult): unknown {
  if (!result.ok) throw new ToolScriptError(spec, result);
  const output = scriptOutputOf(result);
  if (spec.outputSchema !== undefined && output?.structuredContent !== undefined) return output.structuredContent;
  if (output?.text !== undefined) return output.text;
  if (typeof result.content === "string") return result.content;
  if (typeof result.stdout === "string" || typeof result.stderr === "string" || result.exit_code !== undefined) {
    return `stdout:\n${typeof result.stdout === "string" ? result.stdout : ""}\nstderr:\n${typeof result.stderr === "string" ? result.stderr : ""}\nexit_code: ${String(result.exit_code ?? "unknown")}`;
  }
  const { attachmentContent: _attachments, ok: _ok, status: _status, ...business } = result;
  return JSON.stringify(business);
}
