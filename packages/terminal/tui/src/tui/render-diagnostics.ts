import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class RenderWidthError extends Error {
  readonly expected: number;
  readonly actual: number;
  readonly renderedLine: string;
  readonly source: string;

  constructor(expected: number, actual: number, renderedLine: string, source = "unknown component") {
    super(`rendered line exceeds terminal width: ${actual} > ${expected} (${source})`);
    this.expected = expected;
    this.actual = actual;
    this.renderedLine = renderedLine;
    this.source = source;
  }
}

/** A bounded, escaped failing row, never a full transcript or editor source. */
export function recordRenderFailure(error: unknown): unknown {
  if (!(error instanceof RenderWidthError)) return error;
  try {
    const directory = mkdtempSync(join(tmpdir(), "laohuang-tui-error-"));
    const path = join(directory, "render.json");
    writeFileSync(path, JSON.stringify({
      timestamp: new Date().toISOString(), source: error.source,
      expected: error.expected, actual: error.actual,
      renderedLine: error.renderedLine.slice(0, 4096),
    }, null, 2), { mode: 0o600 });
    error.message += `; diagnostic: ${path}`;
  } catch { /* Preserve the original rendering error if diagnostics cannot be written. */ }
  return error;
}
