import { visibleWidth, wrapTextToWidth } from "../screen.ts";

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

function ansiCodes(style: string): string[] {
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
        const prefix = nextColorIsBackground ? "48" : "38";
        codes.push(`${prefix};2;${rgb[0]};${rgb[1]};${rgb[2]}`);
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

export function ansiStyledText(style: string, text: string): string {
  if (!style || !text) {
    return text;
  }
  const codes = ansiCodes(style);
  if (codes.length === 0) {
    return text;
  }
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
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
    ansiStyledText(style, `${padLine(line, width)}\n`),
  );
}

export function styledPlainLines(text: string, width: number, style: string): string[] {
  return wrapTextToWidth(text, width).map((line) =>
    ansiStyledText(style, `${line}\n`),
  );
}

export function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
