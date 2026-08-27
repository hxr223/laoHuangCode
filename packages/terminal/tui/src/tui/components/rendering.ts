import { visibleWidth, wrapTextToWidth } from "../screen.ts";
import { compileLegacyStyledText } from "../ansi-renderer.ts";

export function ansiStyledText(style: string, text: string): string {
  return compileLegacyStyledText(style, text);
}

export function padLine(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

export function styledBackgroundLines(
  text: string,
  width: number,
  style: string,
): string[] {
  return wrapTextToWidth(text, width).map((line) =>
    ansiStyledText(style, padLine(line, width)),
  );
}

export function styledPlainLines(text: string, width: number, style: string): string[] {
  return wrapTextToWidth(text, width).map((line) =>
    ansiStyledText(style, line),
  );
}

export function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
