export interface CodeModeSourceOptions {
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
}

export class CodeModeSourceError extends Error {
  constructor(message: string) { super(message); this.name = "CodeModeSourceError"; }
}

/** Preserve the directive's newline so VM diagnostics match the submitted source. */
export function parseCodeModeSource(source: string): { code: string; options: CodeModeSourceOptions } {
  if (!source.trim()) throw new CodeModeSourceError("Expected non-empty JavaScript source");
  const prefix = "// @options:";
  const lines = source.split("\n");
  if (lines.some((line, index) => index > 0 && line.trimStart().startsWith(prefix))) throw new CodeModeSourceError("@options must be on the first line");
  const first = lines[0]!.trim();
  if (!first.startsWith(prefix)) return { code: source, options: {} };
  const newline = source.indexOf("\n");
  const code = newline < 0 ? "" : source.slice(newline);
  if (!code.trim()) throw new CodeModeSourceError("@options must be followed by JavaScript on subsequent lines");
  let parsed: unknown;
  try { parsed = JSON.parse(first.slice(prefix.length)); }
  catch { throw new CodeModeSourceError("@options must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CodeModeSourceError("@options must be a JSON object");
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).some(key => key !== "timeout_ms" && key !== "max_output_tokens")) throw new CodeModeSourceError("@options only supports timeout_ms and max_output_tokens");
  const timeout = fields.timeout_ms;
  const tokens = fields.max_output_tokens;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647)) throw new CodeModeSourceError("timeout_ms must be a positive integer up to 2147483647");
  if (tokens !== undefined && (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0)) throw new CodeModeSourceError("max_output_tokens must be a non-negative safe integer");
  return { code, options: { ...(timeout === undefined ? {} : { timeoutMs: timeout as number }), ...(tokens === undefined ? {} : { maxOutputTokens: tokens as number }) } };
}
