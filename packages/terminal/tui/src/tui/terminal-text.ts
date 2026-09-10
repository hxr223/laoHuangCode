import { eastAsianWidth } from "get-east-asian-width";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const nonPrinting = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark})$/u;
const spacingMark = new RegExp(String.raw`^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])$`, "v");
const emoji = new RegExp(String.raw`^\p{RGI_Emoji}$`, "v");
export const TERMINAL_RESET = "\x1b[0m\x1b]8;;\x07";
const widthCache = new Map<string, number>();

export function graphemeClusters(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/** Terminal cell width, including streamed emoji intermediates and spacing marks. */
export function clusterWidth(cluster: string): number {
  if (cluster === "\t") return 3;
  if (emoji.test(cluster)) return 2;
  const chars = [...cluster];
  let width = 0;
  let foundBase = false;
  let followsMark = false;
  for (const char of chars) {
    const cp = char.codePointAt(0)!;
    if (spacingMark.test(char)) {
      width += 1;
      followsMark = false;
    } else if (nonPrinting.test(char)) {
      if (/\p{Mark}/u.test(char)) followsMark = true;
    } else if (!foundBase) {
      if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
      width += eastAsianWidth(cp);
      foundBase = true;
      followsMark = false;
    } else {
      if (followsMark || (cp >= 0xff00 && cp <= 0xffef)) width += eastAsianWidth(cp);
      else if (cp === 0x0e33 || cp === 0x0eb3) width += 1;
      followsMark = false;
    }
  }
  return width;
}

export function charCellWidth(char: string): number {
  return clusterWidth(char);
}

export function normalizeDisplayCluster(cluster: string): string {
  return cluster === "\t" ? "   " : cluster.replace(/[\uD800-\uDFFF]/gu, "�").replace(/\u0e33/g, "\u0e4d\u0e32").replace(/\u0eb3/g, "\u0ecd\u0eb2");
}

/** End of one complete or incomplete control sequence; always advances. */
function escapeEnd(text: string, start: number): number {
  const marker = text[start + 1];
  if (marker === "[") {
    let end = start + 2;
    while (end < text.length) {
      const cp = text.charCodeAt(end++);
      if (cp >= 0x40 && cp <= 0x7e) break;
    }
    return end;
  }
  if (marker === "]" || marker === "P" || marker === "_" || marker === "^" || marker === "X") {
    let end = start + 2;
    while (end < text.length) {
      if (text[end] === "\x07") return end + 1;
      if (text[end] === "\x1b" && text[end + 1] === "\\") return end + 2;
      end++;
    }
    return end;
  }
  return Math.min(text.length, start + 2);
}

export function stripTerminalControls(text: string): string {
  let result = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\x1b") index = escapeEnd(text, index);
    else {
      const char = text[index++]!;
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(char)) result += char;
    }
  }
  return result;
}

export function visibleWidth(text: string): number {
  if (/^[\x20-\x7e]*$/u.test(text)) return text.length;
  const cached = widthCache.get(text);
  if (cached !== undefined) return cached;
  let width = 0;
  for (const { segment } of segmenter.segment(stripTerminalControls(text))) width += clusterWidth(segment);
  if (text.length <= 4096) {
    if (widthCache.size >= 512) widthCache.delete(widthCache.keys().next().value!);
    widthCache.set(text, width);
  }
  return width;
}

class TerminalStyle {
  readonly codes = new Map<number, string>();
  link = "";

  accept(sequence: string): void {
    if (sequence.startsWith("\x1b]8;")) {
      const match = /^\x1b\]8;[^;]*;([^\x00-\x1f\x7f]*)(?:\x07|\x1b\\)$/u.exec(sequence);
      if (match) this.link = match[1] ? `\x1b]8;;${match[1]}\x07` : "";
      return;
    }
    if (!/^\x1b\[[\d;]*m$/u.test(sequence)) return;
    const parts = sequence.slice(2, -1).split(";").map(Number);
    for (let index = 0; index < parts.length; index++) {
      const code = parts[index]!;
      if (code === 0) this.codes.clear();
      else if (code === 38 || code === 48) {
        const count = parts[index + 1] === 5 ? 3 : parts[index + 1] === 2 ? 5 : 1;
        if (index + count <= parts.length) this.codes.set(code, parts.slice(index, index + count).join(";"));
        index += count - 1;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) this.codes.set(38, String(code));
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) this.codes.set(48, String(code));
      else if (code === 39) this.codes.delete(38);
      else if (code === 49) this.codes.delete(48);
      else if (code === 22) { this.codes.delete(1); this.codes.delete(2); }
      else if (code >= 23 && code <= 29) this.codes.delete(code - 20);
      else if (code >= 1 && code <= 9) this.codes.set(code, String(code));
    }
  }

  prefix(): string {
    return (this.codes.size ? `\x1b[${[...this.codes.values()].join(";")}m` : "") + this.link;
  }
}

interface TerminalCell {
  readonly text: string;
  readonly width: number;
  readonly prefix: string;
}

/** Segment visible text across ANSI boundaries, assigning the first base's style to the whole grapheme. */
function terminalCells(text: string): TerminalCell[] {
  const style = new TerminalStyle();
  const runs: { start: number; prefix: string }[] = [];
  let clean = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\x1b") {
      const end = escapeEnd(text, index);
      style.accept(text.slice(index, end));
      index = end;
    } else {
      const end = text.indexOf("\x1b", index);
      runs.push({ start: clean.length, prefix: style.prefix() });
      clean += stripTerminalControls(text.slice(index, end < 0 ? text.length : end));
      index = end < 0 ? text.length : end;
    }
  }
  const cells: TerminalCell[] = [];
  let run = 0;
  for (const { segment, index } of segmenter.segment(clean)) {
    while (run + 1 < runs.length && runs[run + 1]!.start <= index) run++;
    cells.push({ text: normalizeDisplayCluster(segment), width: clusterWidth(segment), prefix: runs[run]?.prefix ?? "" });
  }
  return cells;
}

function encodeCells(cells: readonly TerminalCell[]): string {
  let prefix = "";
  let result = "";
  for (const cell of cells) {
    if (cell.prefix !== prefix) {
      if (prefix) result += prefix.includes("\x1b]8;") ? TERMINAL_RESET : "\x1b[0m";
      result += cell.prefix;
      prefix = cell.prefix;
    }
    result += cell.text;
  }
  return result + (prefix ? (prefix.includes("\x1b]8;") ? TERMINAL_RESET : "\x1b[0m") : "");
}

export function normalizeTerminalOutput(text: string): string {
  if (!/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f\u0e33\u0eb3\uD800-\uDFFF]/u.test(text)) return text;
  return encodeCells(terminalCells(text));
}

export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (/^[\x20-\x7e]*$/u.test(text)) return text.slice(0, width);
  const cells: TerminalCell[] = [];
  let used = 0;
  for (const cell of terminalCells(text)) {
    if (used + cell.width > width) break;
    cells.push(cell);
    used += cell.width;
  }
  return encodeCells(cells);
}

export function wrapTextToWidth(text: string, width: number): string[] {
  const target = Math.max(1, width);
  const lines: string[] = [];
  let row: TerminalCell[] = [];
  let used = 0;
  for (const cell of terminalCells(text)) {
    if (/^[\r\n]+$/u.test(cell.text)) {
      lines.push(encodeCells(row)); row = []; used = 0;
      continue;
    }
    const next = cell.width > target ? { ...cell, text: "�", width: 1 } : cell;
    if (used > 0 && used + next.width > target) {
      lines.push(encodeCells(row)); row = []; used = 0;
    }
    row.push(next); used += next.width;
  }
  lines.push(encodeCells(row));
  return lines;
}

/** Exact-width column slice: a partially intersected wide character becomes spaces. */
export function sliceByColumn(text: string, start: number, width: number): string {
  const cells: TerminalCell[] = [];
  let column = 0;
  let used = 0;
  for (const cell of terminalCells(text)) {
    const end = column + cell.width;
    if (end > start && column < start + width) {
      const overlap = Math.min(end, start + width) - Math.max(column, start);
      cells.push(overlap === cell.width ? cell : { ...cell, text: " ".repeat(overlap), width: overlap });
      used += overlap;
    }
    column = end;
    if (column >= start + width) break;
  }
  return encodeCells(cells) + " ".repeat(Math.max(0, width - used));
}

export function previousGraphemeBoundary(text: string, offset: number): number {
  let previous = 0;
  for (const { index } of segmenter.segment(text)) {
    if (index >= offset) break;
    previous = index;
  }
  return previous;
}

export function nextGraphemeBoundary(text: string, offset: number): number {
  for (const { index } of segmenter.segment(text)) if (index > offset) return index;
  return text.length;
}

/** Text and caret share one layout pass; offsets remain UTF-16 source offsets. */
export function projectInput(text: string, cursor: number, width: number, prompt: string, mask: boolean): {
  rows: string[]; prompt: string; promptWidth: number; cursorRow: number; cursorColumn: number;
} {
  const target = Math.max(1, width);
  const displayedPrompt = truncateToWidth(stripTerminalControls(prompt), Math.max(0, target - 1));
  const promptWidth = visibleWidth(displayedPrompt);
  const contentWidth = Math.max(1, target - promptWidth);
  const rows: string[] = [];
  let row = "";
  let column = 0;
  let cursorRow = 0;
  let cursorColumn = promptWidth;
  const placeCursor = (): void => {
    cursorRow = rows.length + (column === contentWidth ? 1 : 0);
    cursorColumn = promptWidth + (column === contentWidth ? 0 : column);
  };
  for (const { segment, index } of segmenter.segment(text)) {
    if (cursor >= index) placeCursor();
    if (/^[\r\n]+$/u.test(segment)) {
      rows.push(row); row = ""; column = 0;
      if (cursor >= index + segment.length) placeCursor();
      continue;
    }
    let display = mask ? "*" : normalizeDisplayCluster(segment.replace(/\x1b/g, "␛").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, ""));
    let cells = mask ? 1 : visibleWidth(display);
    if (cells > contentWidth) { display = "�"; cells = 1; }
    if (column > 0 && column + cells > contentWidth) {
      rows.push(row); row = ""; column = 0;
      if (cursor >= index) placeCursor();
    }
    row += display; column += cells;
    if (cursor >= index + segment.length) placeCursor();
  }
  rows.push(row);
  if (column === contentWidth) rows.push("");
  return { rows, prompt: displayedPrompt, promptWidth, cursorRow: Math.min(cursorRow, rows.length - 1), cursorColumn: Math.min(target - 1, cursorColumn) };
}
