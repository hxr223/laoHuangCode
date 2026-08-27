import { charCellWidth } from "./screen.ts";
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

export function wrapStyledSpans(
  spans: readonly StyledSpan[],
  width: number,
): StyledLine[] {
  const targetWidth = Math.max(1, width);
  const lines: StyledLine[] = [];
  let current: StyledSpan[] = [];
  let currentWidth = 0;

  const append = (text: string, style: SpanStyle | undefined): void => {
    const previous = current.at(-1);
    if (previous !== undefined && previous.style === style) {
      current[current.length - 1] = span(previous.text + text, style);
      return;
    }
    current.push(span(text, style));
  };
  const finish = (): void => {
    lines.push(line(...current));
    current = [];
    currentWidth = 0;
  };

  for (const source of spans) {
    for (const character of source.text) {
      if (character === "\n" || character === "\r") {
        finish();
        continue;
      }
      const characterWidth = charCellWidth(character);
      if (currentWidth > 0 && currentWidth + characterWidth > targetWidth) {
        finish();
      }
      if (characterWidth > targetWidth) {
        continue;
      }
      append(character, source.style);
      currentWidth += characterWidth;
    }
  }
  finish();
  return lines;
}

export function truncateStyledLine(
  value: StyledLine,
  width: number,
  ellipsis = "…",
): StyledLine {
  if (width <= 0) {
    return plainLine("");
  }

  const result: StyledSpan[] = [];
  let used = 0;
  let truncated = false;
  let trailingStyle: SpanStyle | undefined;
  for (const source of value.spans) {
    for (const character of source.text) {
      const characterWidth = charCellWidth(character);
      if (used + characterWidth > width) {
        truncated = true;
        trailingStyle = source.style;
        break;
      }
      result.push(span(character, source.style));
      used += characterWidth;
      trailingStyle = source.style;
    }
    if (truncated) {
      break;
    }
  }
  if (!truncated) {
    return line(...mergeAdjacent(result));
  }

  const ellipsisWidth = charCellWidth(ellipsis);
  while (result.length > 0 && used + ellipsisWidth > width) {
    const removed = result.pop() as StyledSpan;
    used -= charCellWidth(removed.text);
    trailingStyle = removed.style;
  }
  if (ellipsisWidth <= width) {
    result.push(span(ellipsis, trailingStyle));
  }
  return line(...mergeAdjacent(result));
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

function styledLineWidth(value: StyledLine): number {
  let width = 0;
  for (const character of lineText(value)) {
    width += charCellWidth(character);
  }
  return width;
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
