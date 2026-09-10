import { clusterWidth, graphemeClusters, stripTerminalControls, normalizeDisplayCluster, visibleWidth } from "./terminal-text.ts";
import type { TerminalTheme } from "./theme.ts";

export type StyleToken =
  | "accent"
  | "text"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "user_bg"
  | "tool_pending_bg"
  | "tool_success_bg"
  | "tool_error_bg"
  | "card"
  | "code"
  | "heading"
  | "link"
  | "thinking"
  | "bash";

export interface SpanStyle {
  readonly hyperlink?: string;
  readonly foreground?: StyleToken;
  readonly background?: StyleToken;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly dim?: boolean;
}

export interface StyledSpan {
  readonly text: string;
  readonly style?: SpanStyle;
}

export interface StyledLine {
  readonly spans: readonly StyledSpan[];
}

export interface RenderContext {
  readonly width: number;
  readonly theme: TerminalTheme;
}

export interface ComponentRenderResult {
  readonly lines: readonly StyledLine[];
  readonly cursor?: { readonly row: number; readonly column: number };
}

export function span(text: string, style?: SpanStyle): StyledSpan {
  return style === undefined ? { text } : { text, style };
}

export function line(...spans: readonly StyledSpan[]): StyledLine {
  return { spans };
}

export function plainLine(text: string): StyledLine {
  return line(span(text));
}

export function lineText(value: StyledLine): string {
  return value.spans.map((item) => item.text).join("");
}

/** Whole graphemes across span boundaries; the starting span owns the grapheme style. */
export function styledClusters(spans: readonly StyledSpan[]): StyledSpan[] {
  const sources = spans.map(source => ({ ...source, text: stripTerminalControls(source.text) }));
  const text = sources.map(source => source.text).join("");
  let sourceIndex = 0;
  let sourceEnd = sources[0]?.text.length ?? 0;
  let offset = 0;
  const result: StyledSpan[] = [];
  for (const cluster of graphemeClusters(text)) {
    while (sourceIndex + 1 < sources.length && sourceEnd <= offset) {
      sourceEnd += sources[++sourceIndex]!.text.length;
    }
    result.push(span(normalizeDisplayCluster(cluster), sources[sourceIndex]?.style));
    offset += cluster.length;
  }
  return result;
}

export function wrapStyledSpans(spans: readonly StyledSpan[], width: number): StyledLine[] {
  const target = Math.max(1, width);
  const lines: StyledLine[] = [];
  let row: StyledSpan[] = [];
  let used = 0;
  for (const source of styledClusters(spans)) {
    if (/^[\r\n]+$/u.test(source.text)) {
      lines.push(line(...mergeAdjacent(row))); row = []; used = 0;
      continue;
    }
    const measured = visibleWidth(source.text);
    const cell = measured > target ? span("�", source.style) : source;
    const cellWidth = measured > target ? 1 : measured;
    if (used > 0 && used + cellWidth > target) {
      lines.push(line(...mergeAdjacent(row))); row = []; used = 0;
    }
    row.push(cell); used += cellWidth;
  }
  lines.push(line(...mergeAdjacent(row)));
  return lines;
}

export function truncateStyledLine(value: StyledLine, width: number, ellipsis = "…"): StyledLine {
  if (width <= 0) return plainLine("");
  const result: StyledSpan[] = [];
  let used = 0;
  let truncated = false;
  for (const source of styledClusters(value.spans)) {
    const measured = textWidth(source.text);
    if (used + measured > width) { truncated = true; break; }
    result.push(source); used += measured;
  }
  if (truncated && ellipsis) {
    const suffix = truncateStyledLine(plainLine(ellipsis), width, "");
    const suffixWidth = styledLineWidth(suffix);
    while (result.length && used + suffixWidth > width) used -= textWidth(result.pop()!.text);
    result.push(...suffix.spans.map(part => span(part.text, result.at(-1)?.style)));
  }
  return line(...mergeAdjacent(result));
}

function textWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemeClusters(text)) width += clusterWidth(cluster);
  return width;
}

export function padStyledLine(
  value: StyledLine,
  width: number,
  background?: StyleToken,
): StyledLine {
  const padding = width - styledLineWidth(value);
  if (padding <= 0) {
    return value;
  }
  return line(
    ...value.spans,
    span(" ".repeat(padding), background === undefined ? undefined : { background }),
  );
}

export function styledLineWidth(value: StyledLine): number {
  return textWidth(lineText(value));
}

function mergeAdjacent(spans: readonly StyledSpan[]): StyledSpan[] {
  const merged: StyledSpan[] = [];
  for (const item of spans) {
    const previous = merged.at(-1);
    if (previous !== undefined && previous.style === item.style) {
      merged[merged.length - 1] = span(previous.text + item.text, item.style);
      continue;
    }
    merged.push(item);
  }
  return merged;
}
