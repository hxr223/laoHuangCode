/**
 * Convert Markdown into styled ANSI logical lines without terminal I/O.
 *
 * Hand-written replacement for the Python version's Rich + prompt_toolkit
 * pipeline: a small block/inline Markdown parser emits styled segments,
 * which are word-wrapped and serialized as ANSI SGR strings. Each returned
 * line is one logical line with no newline and fits the requested visible
 * width, with any open SGR style closed before truncation.
 *
 * Rich-fidelity behaviors mirrored from Python's `render_markdown_lines`:
 * links render their URL in parentheses, tables render as a bordered grid,
 * list items keep a hanging indent on wrapped continuation lines, and
 * block-level elements are separated by blank lines (container blocks —
 * lists, tables, quotes — also carry a leading blank line, and a horizontal
 * rule emits its own trailing blank line).
 */

import type { TerminalTheme } from "./theme.ts";
import {
  clusterWidth,
  graphemeClusters,
  stripTerminalControls,
  truncateToWidth,
} from "./screen.ts";

// The visible-width/escape-sequence helpers are owned by terminal/screen.ts;
// visibleWidth is re-exported for existing consumers of this module.
export { visibleWidth } from "./screen.ts";

/** Render Markdown as ANSI logical lines that each fit `width` columns. */
export function renderMarkdownLines(
  text: string,
  width: number,
  theme: TerminalTheme,
): string[] {
  const clean = stripTerminalControls(text);
  if (!clean.trim()) {
    return [];
  }
  // Rich lays out at max(12, width) and each line is then truncated to the
  // requested width; keep the same two-step behavior.
  const layoutWidth = Math.max(12, width);
  const lines: string[] = [];
  let previous: BlockKind | null = null;
  for (const block of renderBlocks(clean, theme, layoutWidth)) {
    // Rich yields one blank line before each block-level element whose
    // predecessor sets new_line (every element except a horizontal rule).
    // Container blocks nest paragraph children, so the flag is already set
    // when they render first — hence the leading blank at document start.
    const leadingBlank =
      previous === null
        ? block.kind === "list" ||
          block.kind === "table" ||
          block.kind === "quote"
        : previous !== "hr";
    if (leadingBlank) {
      lines.push("");
    }
    for (const line of block.lines) {
      lines.push(truncateToWidth(serializeLine(line), width));
    }
    // Rich's HorizontalRule yields an empty Text after the rule itself.
    if (block.kind === "hr") {
      lines.push("");
    }
    previous = block.kind;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Markdown parsing and rendering
// ---------------------------------------------------------------------------

type BlockKind =
  | "paragraph"
  | "heading"
  | "code"
  | "hr"
  | "quote"
  | "list"
  | "table";

interface Block {
  kind: BlockKind;
  /** Logical lines already laid out to the layout width. */
  lines: Segment[][];
}

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  fg?: string;
  bg?: string;
}

interface Segment {
  style: InlineStyle;
  text: string;
}

function styleKey(style: InlineStyle): string {
  return [
    style.bold ? "b" : "",
    style.italic ? "i" : "",
    style.strike ? "s" : "",
    style.underline ? "u" : "",
    style.fg ?? "",
    style.bg ?? "",
  ].join("|");
}

function styleCodes(style: InlineStyle): string {
  const codes: string[] = [];
  if (style.bold) {
    codes.push("1");
  }
  if (style.italic) {
    codes.push("3");
  }
  if (style.underline) {
    codes.push("4");
  }
  if (style.strike) {
    codes.push("9");
  }
  if (style.fg) {
    codes.push(`38;2;${hexToRgb(style.fg)}`);
  }
  if (style.bg) {
    codes.push(`48;2;${hexToRgb(style.bg)}`);
  }
  return codes.join(";");
}

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r};${g};${b}`;
}

/** Parse the document into blocks with pre-wrapped styled lines. */
function renderBlocks(
  text: string,
  theme: TerminalTheme,
  layoutWidth: number,
): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    const content = paragraph.join(" ").trim();
    paragraph = [];
    if (content) {
      blocks.push({
        kind: "paragraph",
        lines: wrapSegments(parseInline(content, {}, theme), layoutWidth),
      });
    }
  };

  while (index < lines.length) {
    const line = lines[index] as string;
    const trimmed = line.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      flushParagraph();
      const fence = trimmed.slice(0, 3);
      index += 1;
      const codeStyle: InlineStyle = {
        fg: theme.color("code"),
        bg: theme.color("card"),
      };
      const codeLines: Segment[][] = [];
      while (index < lines.length) {
        const body = lines[index] as string;
        if (body.trim().startsWith(fence)) {
          index += 1;
          break;
        }
        codeLines.push(
          ...(body
            ? wrapSegments([{ style: codeStyle, text: body }], layoutWidth)
            : [[]]),
        );
        index += 1;
      }
      blocks.push({ kind: "code", lines: codeLines });
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    // A table is a header row followed by a delimiter row of dashes.
    if (trimmed.includes("|") && index + 1 < lines.length) {
      const header = splitTableRow(trimmed);
      const delimiter = splitTableRow((lines[index + 1] as string).trim());
      if (
        header !== null &&
        delimiter !== null &&
        delimiter.length === header.length &&
        delimiter.every((cell) => /^:?-+:?$/.test(cell))
      ) {
        flushParagraph();
        index += 2;
        const rows: string[][] = [];
        while (index < lines.length) {
          const rowLine = (lines[index] as string).trim();
          if (!rowLine) {
            break;
          }
          const cells = splitTableRow(rowLine);
          if (cells === null) {
            break;
          }
          rows.push(cells);
          index += 1;
        }
        blocks.push({
          kind: "table",
          lines: renderTable(header, rows, theme, layoutWidth),
        });
        continue;
      }
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        lines: wrapSegments(
          parseInline(
            (heading[2] as string).replace(/\s+#+\s*$/, ""),
            { bold: true, fg: theme.color("heading") },
            theme,
          ),
          layoutWidth,
        ),
      });
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push({
        kind: "hr",
        lines: [
          [
            {
              style: { fg: theme.color("border_muted") },
              text: "─".repeat(layoutWidth),
            },
          ],
        ],
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const content: string[] = [];
      while (index < lines.length) {
        const match = /^>\s?(.*)$/.exec((lines[index] as string).trim());
        if (!match) {
          break;
        }
        content.push(match[1] as string);
        index += 1;
      }
      const quote = content.join(" ").trim();
      if (quote) {
        blocks.push({
          kind: "quote",
          lines: wrapSegments(
            parseInline(
              quote,
              { italic: true, fg: theme.color("thinking") },
              theme,
            ),
            layoutWidth,
          ),
        });
      }
      continue;
    }

    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph();
      const items: Segment[][] = [];
      while (index < lines.length) {
        const match = /^[-*+]\s+(.*)$/.exec((lines[index] as string).trim());
        if (!match) {
          break;
        }
        items.push(parseInline(match[1] as string, {}, theme));
        index += 1;
      }
      blocks.push({
        kind: "list",
        lines: renderListItems(items, () => " • ", theme, layoutWidth),
      });
      continue;
    }

    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      const start = parseInt(numbered[1] as string, 10);
      const items: Segment[][] = [parseInline(numbered[2] as string, {}, theme)];
      index += 1;
      while (index < lines.length) {
        const match = /^(\d+)[.)]\s+(.*)$/.exec((lines[index] as string).trim());
        if (!match) {
          break;
        }
        items.push(parseInline(match[2] as string, {}, theme));
        index += 1;
      }
      // Rich sizes the number column from start + item count, right-aligns
      // each numeral, and follows it with one space.
      const numberWidth = String(start + items.length).length + 2;
      blocks.push({
        kind: "list",
        lines: renderListItems(
          items,
          (item) => String(start + item).padStart(numberWidth - 1) + " ",
          theme,
          layoutWidth,
        ),
      });
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

/** Render list items with the marker and a hanging indent, Rich-style. */
function renderListItems(
  items: Segment[][],
  prefixFor: (index: number) => string,
  theme: TerminalTheme,
  layoutWidth: number,
): Segment[][] {
  const marker: InlineStyle = { fg: theme.color("accent") };
  const lines: Segment[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const prefix = prefixFor(index);
    const wrapped = wrapSegments(
      items[index] as Segment[],
      Math.max(1, layoutWidth - prefix.length),
    );
    if (wrapped.length === 0) {
      lines.push([{ style: marker, text: prefix }]);
      continue;
    }
    for (let row = 0; row < wrapped.length; row += 1) {
      lines.push([
        {
          style: marker,
          text: row === 0 ? prefix : " ".repeat(prefix.length),
        },
        ...(wrapped[row] as Segment[]),
      ]);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tables (Rich's SIMPLE box: blank edges, dashed header separator)
// ---------------------------------------------------------------------------

/** Theme token lookup that tolerates missing or malformed entries. */
function tableColor(
  theme: TerminalTheme,
  token: string,
  fallback: string,
): string {
  const value = theme.colors[token];
  return value !== undefined && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : theme.color(fallback);
}

/** Split a pipe-delimited table row into trimmed cells. */
function splitTableRow(line: string): string[] | null {
  if (!line.includes("|")) {
    return null;
  }
  let rest = line;
  if (rest.startsWith("|")) {
    rest = rest.slice(1);
  }
  if (rest.endsWith("|")) {
    rest = rest.slice(0, -1);
  }
  return rest.split("|").map((cell) => cell.trim());
}

/** Visible width of a segment list. */
function segmentsWidth(segments: Segment[]): number {
  let width = 0;
  for (const segment of segments) {
    for (const cluster of graphemeClusters(segment.text)) {
      width += clusterWidth(cluster);
    }
  }
  return width;
}

/** Lay out a table as a grid of styled lines that fits `layoutWidth`. */
function renderTable(
  header: string[],
  rows: string[][],
  theme: TerminalTheme,
  layoutWidth: number,
): Segment[][] {
  const columnCount = header.length;
  const borderStyle: InlineStyle = {
    fg: tableColor(theme, "markdown.table.border", "border_muted"),
  };
  const headerStyle: InlineStyle = {
    bold: true,
    fg: tableColor(theme, "markdown.table.header", "heading"),
  };
  const normalize = (cells: string[]): string[] =>
    Array.from({ length: columnCount }, (_, i) => cells[i] ?? "");
  const headerCells = normalize(header).map((cell) =>
    parseInline(cell, headerStyle, theme),
  );
  const bodyCells = rows.map((row) =>
    normalize(row).map((cell) => parseInline(cell, {}, theme)),
  );

  const widths = Array.from({ length: columnCount }, (_, i) =>
    Math.max(
      1,
      segmentsWidth(headerCells[i] as Segment[]),
      ...bodyCells.map((row) => segmentsWidth(row[i] as Segment[])),
    ),
  );
  const totalWidth = (): number =>
    widths.reduce((total, w) => total + w, 0) + 2 * (columnCount - 1) + 2;
  while (totalWidth() > layoutWidth && Math.max(...widths) > 1) {
    let widest = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if ((widths[i] as number) > (widths[widest] as number)) {
        widest = i;
      }
    }
    widths[widest] = (widths[widest] as number) - 1;
  }

  const inner = widths.reduce((total, w) => total + w, 0) + 2 * (columnCount - 1);
  const lines: Segment[][] = [];
  lines.push([{ style: borderStyle, text: " ".repeat(inner + 2) }]);
  lines.push(...renderTableRows(headerCells, widths, borderStyle, headerStyle));
  lines.push([{ style: borderStyle, text: ` ${"─".repeat(inner)} ` }]);
  for (const row of bodyCells) {
    lines.push(...renderTableRows(row, widths, borderStyle, {}));
  }
  lines.push([{ style: borderStyle, text: " ".repeat(inner + 2) }]);
  return lines;
}

/** Render one table row (possibly several physical lines after wrapping). */
function renderTableRows(
  cells: Segment[][],
  widths: number[],
  borderStyle: InlineStyle,
  padStyle: InlineStyle,
): Segment[][] {
  const wrappedCells = cells.map((cell, i) => {
    const wrapped = wrapSegments(cell, widths[i] as number);
    return wrapped.length > 0 ? wrapped : [[]];
  });
  const height = Math.max(...wrappedCells.map((cell) => cell.length));
  const lines: Segment[][] = [];
  for (let row = 0; row < height; row += 1) {
    // pad_edge=False: outer padding only comes from the (blank) box edges,
    // so interior columns keep one styled space on each side.
    const line: Segment[] = [{ style: borderStyle, text: " " }];
    for (let i = 0; i < cells.length; i += 1) {
      if (i > 0) {
        line.push({ style: borderStyle, text: " " });
      }
      const cellLine = (wrappedCells[i] as Segment[][])[row] as Segment[];
      line.push(...cellLine);
      const pad = (widths[i] as number) - segmentsWidth(cellLine);
      if (pad > 0) {
        line.push({ style: padStyle, text: " ".repeat(pad) });
      }
      if (i < cells.length - 1) {
        line.push({ style: padStyle, text: " " });
      }
    }
    line.push({ style: borderStyle, text: " " });
    lines.push(mergeSegments(line));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

interface InlinePattern {
  pattern: RegExp;
  style?: (theme: TerminalTheme, base: InlineStyle) => InlineStyle;
  /** Produce replacement segments directly, bypassing delimiter stripping. */
  expand?: (
    theme: TerminalTheme,
    base: InlineStyle,
    match: RegExpExecArray,
  ) => Segment[];
}

const INLINE_PATTERNS: InlinePattern[] = [
  {
    // Inline code: no further parsing inside backticks.
    pattern: /`([^`]+)`/,
    style: (theme) => ({ fg: theme.color("code"), bg: theme.color("card") }),
  },
  {
    pattern: /\*\*([^*]+)\*\*/,
    style: (_theme, base) => ({ ...base, bold: true }),
  },
  {
    pattern: /__([^_]+)__/,
    style: (_theme, base) => ({ ...base, bold: true }),
  },
  {
    pattern: /~~([^~]+)~~/,
    style: (theme, base) => ({
      ...base,
      strike: true,
      fg: theme.color("muted"),
    }),
  },
  {
    pattern: /\*([^*]+)\*/,
    style: (_theme, base) => ({ ...base, italic: true }),
  },
  {
    pattern: /(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/,
    style: (_theme, base) => ({ ...base, italic: true }),
  },
  {
    // Links and images: visible text plus the URL in parentheses, matching
    // Rich's hyperlinks=False output, never OSC-8 controls. Rich renders
    // the link text as plain (unparsed) content.
    pattern: /!?\[([^\]]*)\]\(([^)\s]+)\)/,
    expand: (theme, base, match) => [
      {
        style: { ...base, underline: true, fg: theme.color("link") },
        text: match[1] as string,
      },
      { style: base, text: " (" },
      {
        style: { ...base, fg: theme.color("muted") },
        text: match[2] as string,
      },
      { style: base, text: ")" },
    ],
  },
];

function parseInline(
  text: string,
  base: InlineStyle,
  theme: TerminalTheme,
): Segment[] {
  const segments: Segment[] = [];
  let rest = text;
  while (rest) {
    let best: {
      start: number;
      end: number;
      next?: InlineStyle;
      expanded?: Segment[];
    } | null = null;
    for (const { pattern, style, expand } of INLINE_PATTERNS) {
      const match = pattern.exec(rest);
      if (!match) {
        continue;
      }
      if (best !== null && match.index >= best.start) {
        continue;
      }
      if (expand) {
        best = {
          start: match.index,
          end: match.index + match[0].length,
          expanded: expand(theme, base, match),
        };
        continue;
      }
      const next = (style as NonNullable<typeof style>)(theme, base);
      best = {
        start: match.index,
        end: match.index + match[0].length,
        next,
      };
    }
    if (best === null) {
      segments.push({ style: base, text: rest });
      break;
    }
    if (best.start > 0) {
      segments.push({ style: base, text: rest.slice(0, best.start) });
    }
    if (best.expanded) {
      segments.push(...best.expanded);
    } else {
      const inner = rest.slice(best.start, best.end);
      const content = inlineContent(inner);
      segments.push(...parseInline(content, best.next as InlineStyle, theme));
    }
    rest = rest.slice(best.end);
  }
  return mergeSegments(segments);
}

/** Strip the matched delimiters, returning the text inside. */
function inlineContent(matched: string): string {
  if (matched.startsWith("```") || matched.startsWith("`")) {
    return matched.slice(1, -1);
  }
  if (matched.startsWith("**") || matched.startsWith("__")) {
    return matched.slice(2, -2);
  }
  if (matched.startsWith("~~")) {
    return matched.slice(2, -2);
  }
  if (matched.startsWith("*") || matched.startsWith("_")) {
    return matched.slice(1, -1);
  }
  return matched;
}

function mergeSegments(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    if (!segment.text) {
      continue;
    }
    const last = merged[merged.length - 1];
    if (last && styleKey(last.style) === styleKey(segment.style)) {
      last.text += segment.text;
    } else {
      merged.push({ style: segment.style, text: segment.text });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Wrapping and serialization
// ---------------------------------------------------------------------------

interface StyledCluster {
  style: InlineStyle;
  text: string;
  width: number;
  space: boolean;
}

/** Greedy word wrap over styled segments; long words are hard-broken. */
function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const clusters: StyledCluster[] = [];
  for (const segment of segments) {
    for (const cluster of graphemeClusters(segment.text)) {
      clusters.push({
        style: segment.style,
        text: cluster === "\t" ? "   " : cluster,
        width: clusterWidth(cluster),
        space: cluster === " ",
      });
    }
  }

  const words: StyledCluster[][] = [];
  let current: StyledCluster[] = [];
  for (const cluster of clusters) {
    if (cluster.space) {
      if (current.length > 0) {
        words.push(current);
        current = [];
      }
      words.push([cluster]);
    } else {
      current.push(cluster);
    }
  }
  if (current.length > 0) {
    words.push(current);
  }

  const lines: StyledCluster[][] = [];
  let line: StyledCluster[] = [];
  let lineWidth = 0;
  let pendingSpace: StyledCluster | null = null;

  const flushLine = (): void => {
    // Drop a trailing separator space; it is invisible padding.
    lines.push(line);
    line = [];
    lineWidth = 0;
    pendingSpace = null;
  };

  for (const word of words) {
    const wordWidth = word.reduce((total, c) => total + c.width, 0);
    if (word.length === 1 && word[0]?.space) {
      if (line.length > 0) {
        pendingSpace = word[0] as StyledCluster;
      }
      continue;
    }
    if (wordWidth > width) {
      // Hard-break an over-wide word cluster by cluster.
      if (line.length > 0) {
        flushLine();
      }
      for (const cluster of word) {
        if (lineWidth > 0 && lineWidth + cluster.width > width) {
          flushLine();
        }
        line.push(cluster);
        lineWidth += cluster.width;
      }
      continue;
    }
    const separator = pendingSpace !== null && line.length > 0 ? 1 : 0;
    if (line.length > 0 && lineWidth + separator + wordWidth > width) {
      flushLine();
    }
    if (pendingSpace !== null && line.length > 0) {
      line.push(pendingSpace);
      lineWidth += 1;
    }
    pendingSpace = null;
    line.push(...word);
    lineWidth += wordWidth;
  }
  if (line.length > 0) {
    flushLine();
  }

  return lines.map((physical) => regroup(physical));
}

/** Merge adjacent clusters of equal style back into segments. */
function regroup(clusters: StyledCluster[]): Segment[] {
  const segments: Segment[] = [];
  for (const cluster of clusters) {
    const last = segments[segments.length - 1];
    if (last && styleKey(last.style) === styleKey(cluster.style)) {
      last.text += cluster.text;
    } else {
      segments.push({ style: cluster.style, text: cluster.text });
    }
  }
  return segments;
}

/** Serialize one wrapped line as an ANSI string; plain text stays raw. */
function serializeLine(segments: Segment[]): string {
  let out = "";
  for (const segment of segments) {
    const codes = styleCodes(segment.style);
    if (!codes) {
      out += segment.text;
      continue;
    }
    out += `\x1b[${codes}m${segment.text}\x1b[0m`;
  }
  return out;
}
