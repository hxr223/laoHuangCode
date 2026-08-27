import { visibleWidth } from "./screen.ts";
import type { StyledLine, StyledSpan } from "./render-model.ts";
import type { TerminalTheme } from "./theme.ts";

const NAMED_COLOR_CODES: Record<string, string> = {
  black: "30",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  white: "37",
};

export function compileStyledLine(
  value: StyledLine,
  width: number,
  theme: TerminalTheme,
): string {
  const text = value.spans.map((item) => compileSpan(item, theme)).join("");
  const renderedWidth = visibleWidth(text);
  if (renderedWidth > width) {
    throw new Error(
      `rendered line exceeds terminal width: ${renderedWidth} > ${width}`,
    );
  }
  return text;
}

export function compileStyledLines(
  values: readonly StyledLine[],
  width: number,
  theme: TerminalTheme,
): string[] {
  return values.map((value) => compileStyledLine(value, width, theme));
}

/** Preserve legacy string rendering until its components are migrated. */
export function compileLegacyStyledText(style: string, text: string): string {
  if (!style || !text) {
    return text;
  }
  const codes = legacyAnsiCodes(style);
  return codes.length === 0 ? text : `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

function compileSpan(value: StyledSpan, theme: TerminalTheme): string {
  if (value.style === undefined || value.text.length === 0) {
    return value.text;
  }
  const codes: string[] = [];
  if (value.style.bold) {
    codes.push("1");
  }
  if (value.style.dim) {
    codes.push("2");
  }
  if (value.style.italic) {
    codes.push("3");
  }
  if (value.style.underline) {
    codes.push("4");
  }
  if (value.style.foreground !== undefined) {
    codes.push(theme.sgr(value.style.foreground).slice(2, -1));
  }
  if (value.style.background !== undefined) {
    codes.push(theme.sgr(value.style.background, { background: true }).slice(2, -1));
  }
  return codes.length === 0 ? value.text : `\x1b[${codes.join(";")}m${value.text}\x1b[0m`;
}

function legacyAnsiCodes(style: string): string[] {
  const codes: string[] = [];
  let nextColorIsBackground = false;
  for (const token of style.replace(/bg:/g, " bg:").split(/\s+/).filter(Boolean)) {
    if (token === "bold") {
      codes.push("1");
    } else if (token === "dim") {
      codes.push("2");
    } else if (token === "italic") {
      codes.push("3");
    } else if (token === "underline") {
      codes.push("4");
    } else if (token === "on") {
      nextColorIsBackground = true;
    } else if (token.startsWith("bg:#") && token.length === 10) {
      const rgb = hexToRgb(token.slice(3));
      if (rgb !== null) {
        codes.push(`48;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
      }
    } else if (token.startsWith("#") && token.length === 7) {
      const rgb = hexToRgb(token);
      if (rgb !== null) {
        codes.push(`${nextColorIsBackground ? "48" : "38"};2;${rgb[0]};${rgb[1]};${rgb[2]}`);
      }
      nextColorIsBackground = false;
    } else if (token in NAMED_COLOR_CODES) {
      let code = NAMED_COLOR_CODES[token] as string;
      if (nextColorIsBackground) {
        code = String(Number.parseInt(code, 10) + 10);
      }
      codes.push(code);
      nextColorIsBackground = false;
    } else {
      nextColorIsBackground = false;
    }
  }
  return codes;
}

function hexToRgb(value: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    return null;
  }
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}
