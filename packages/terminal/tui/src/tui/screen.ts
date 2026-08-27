/**
 * Incremental renderer for the regular terminal screen, plus the cell-width
 * string helpers its frames rely on.
 *
 * Port of terminal_screen.py: a differential renderer that keeps the
 * terminal append-only (no alternate screen, no full clears except on
 * resize), emitting one synchronized-output write per frame.
 *
 * This module is also the canonical owner of the visible-width,
 * escape-sequence, and wcwidth helpers shared by terminal/markdown.ts and
 * terminal/editor.ts.
 */

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface ScreenFrame {
  lines: readonly string[];
  activeStart: number;
  cursorRow: number;
  cursorCol: number;
}

/** The minimal terminal surface the renderer writes to. */
export interface TerminalDriver {
  write(data: string): void;
  flush(): void;
  getSize(): TerminalSize;
  restore(): void;
}

/** In-memory terminal driver for renderer tests. */
export class MemoryTerminalDriver implements TerminalDriver {
  #size: TerminalSize;
  #writes: string[] = [];
  #resizeListeners = new Set<() => void>();

  flushes = 0;
  restored = false;
  restoreCalls = 0;

  constructor(size: TerminalSize) {
    this.#size = { ...size };
  }

  write(data: string): void {
    this.#writes.push(data);
  }

  flush(): void {
    this.flushes += 1;
  }

  getSize(): TerminalSize {
    return { ...this.#size };
  }

  resize(size: TerminalSize): void {
    this.#size = { ...size };
    for (const listener of this.#resizeListeners) {
      listener();
    }
  }

  onResize(callback: () => void): () => void {
    this.#resizeListeners.add(callback);
    return () => {
      this.#resizeListeners.delete(callback);
    };
  }

  restore(): void {
    this.restored = true;
    this.restoreCalls += 1;
  }

  writes(): string {
    return this.#writes.join("");
  }

  writeChunks(): string[] {
    return [...this.#writes];
  }

  clearWrites(): void {
    this.#writes = [];
  }
}

/** Regular-terminal differential renderer. */
export class PiMainScreenRenderer {
  #terminal: TerminalDriver;
  #previousLines: readonly string[] = [];
  #previousWidth = 0;
  #previousHeight = 0;
  #previousViewportTop = 0;
  #cursorRow = 0;
  #hardwareCursorRow = 0;
  #maxLinesRendered = 0;
  #clearOnShrink: boolean;
  #closed = false;

  constructor(
    terminal: TerminalDriver,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.#terminal = terminal;
    this.#clearOnShrink = env.PI_CLEAR_ON_SHRINK === "1";
  }

  render(frame: ScreenFrame): void {
    if (this.#closed) {
      return;
    }

    const size = this.#terminal.getSize();
    const width = Math.max(1, size.columns);
    const height = Math.max(1, size.rows);
    const newLines = frame.lines;
    PiMainScreenRenderer.#validateLines(newLines, width);

    const widthChanged = this.#previousWidth !== 0 && this.#previousWidth !== width;
    const heightChanged =
      this.#previousHeight !== 0 && this.#previousHeight !== height;
    const previousBufferLength =
      this.#previousHeight > 0
        ? this.#previousViewportTop + this.#previousHeight
        : height;
    const prevViewportTop = heightChanged
      ? Math.max(0, previousBufferLength - height)
      : this.#previousViewportTop;
    let viewportTop = prevViewportTop;
    let hardwareCursorRow = this.#hardwareCursorRow;

    const computeLineDiff = (targetRow: number): number => {
      const currentScreenRow = hardwareCursorRow - prevViewportTop;
      const targetScreenRow = targetRow - viewportTop;
      return targetScreenRow - currentScreenRow;
    };

    const fullRender = (clear: boolean): void => {
      let buffer = "\x1b[?2026h";
      if (clear) {
        buffer += "\x1b[2J\x1b[H\x1b[3J";
      }
      newLines.forEach((line, index) => {
        if (index > 0) {
          buffer += "\r\n";
        }
        buffer += line;
      });
      buffer += "\x1b[?2026l";
      this.#cursorRow = Math.max(0, newLines.length - 1);
      this.#hardwareCursorRow = this.#cursorRow;
      if (clear) {
        this.#maxLinesRendered = newLines.length;
      } else {
        this.#maxLinesRendered = Math.max(this.#maxLinesRendered, newLines.length);
      }
      const bufferLength = Math.max(height, newLines.length);
      this.#previousViewportTop = Math.max(0, bufferLength - height);
      buffer += this.#positionHardwareCursor(frame, width, newLines.length);
      this.#commitState(newLines, width, height);
      this.#terminal.write(buffer);
      this.#terminal.flush();
    };

    if (
      this.#previousLines.length === 0 &&
      !widthChanged &&
      !heightChanged
    ) {
      fullRender(false);
      return;
    }
    if (widthChanged || heightChanged) {
      fullRender(true);
      return;
    }
    if (this.#clearOnShrink && newLines.length < this.#maxLinesRendered) {
      fullRender(true);
      return;
    }

    const span = PiMainScreenRenderer.#changedSpan(this.#previousLines, newLines);
    if (span === null) {
      const buffer = this.#positionHardwareCursor(frame, width, newLines.length);
      this.#previousViewportTop = prevViewportTop;
      this.#previousHeight = height;
      if (buffer) {
        this.#terminal.write(buffer);
      }
      this.#terminal.flush();
      return;
    }

    let [firstChanged, lastChanged] = span;
    const appendedLines = newLines.length > this.#previousLines.length;
    if (appendedLines && firstChanged === -1) {
      firstChanged = this.#previousLines.length;
      lastChanged = newLines.length - 1;
    }
    const appendStart =
      appendedLines &&
      firstChanged === this.#previousLines.length &&
      firstChanged > 0;

    if (firstChanged >= newLines.length) {
      let buffer = "\x1b[?2026h";
      const targetRow = Math.max(0, newLines.length - 1);
      if (targetRow < prevViewportTop) {
        fullRender(true);
        return;
      }
      const lineDiff = computeLineDiff(targetRow);
      if (lineDiff > 0) {
        buffer += `\x1b[${lineDiff}B`;
      } else if (lineDiff < 0) {
        buffer += `\x1b[${-lineDiff}A`;
      }
      buffer += "\r";
      const extraLines = this.#previousLines.length - newLines.length;
      if (extraLines > height) {
        fullRender(true);
        return;
      }
      const clearStartOffset = newLines.length === 0 ? 0 : 1;
      if (extraLines > 0 && clearStartOffset > 0) {
        buffer += `\x1b[${clearStartOffset}B`;
      }
      for (let index = 0; index < extraLines; index += 1) {
        buffer += "\r\x1b[2K";
        if (index < extraLines - 1) {
          buffer += "\x1b[1B";
        }
      }
      const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
      if (moveBack > 0) {
        buffer += `\x1b[${moveBack}A`;
      }
      buffer += "\x1b[?2026l";
      this.#cursorRow = targetRow;
      this.#hardwareCursorRow = targetRow;
      buffer += this.#positionHardwareCursor(frame, width, newLines.length);
      this.#previousViewportTop = prevViewportTop;
      this.#commitState(newLines, width, height);
      this.#terminal.write(buffer);
      this.#terminal.flush();
      return;
    }

    if (firstChanged < prevViewportTop) {
      fullRender(true);
      return;
    }

    let buffer = "\x1b[?2026h";
    const prevViewportBottom = prevViewportTop + height - 1;
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(
        0,
        Math.min(height - 1, hardwareCursorRow - prevViewportTop),
      );
      const moveToBottom = height - 1 - currentScreenRow;
      if (moveToBottom > 0) {
        buffer += `\x1b[${moveToBottom}B`;
      }
      const scroll = moveTargetRow - prevViewportBottom;
      buffer += "\r\n".repeat(scroll);
      viewportTop += scroll;
      hardwareCursorRow = moveTargetRow;
    }

    const lineDiff = computeLineDiff(moveTargetRow);
    if (lineDiff > 0) {
      buffer += `\x1b[${lineDiff}B`;
    } else if (lineDiff < 0) {
      buffer += `\x1b[${-lineDiff}A`;
    }
    buffer += appendStart ? "\r\n" : "\r";

    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let index = firstChanged; index <= renderEnd; index += 1) {
      if (index > firstChanged) {
        buffer += "\r\n";
      }
      buffer += "\x1b[2K";
      buffer += newLines[index] as string;
    }

    let finalCursorRow = renderEnd;
    if (this.#previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd;
        buffer += `\x1b[${moveDown}B`;
        finalCursorRow = newLines.length - 1;
      }
      const extraLines = this.#previousLines.length - newLines.length;
      for (let index = newLines.length; index < this.#previousLines.length; index += 1) {
        buffer += "\r\n\x1b[2K";
      }
      buffer += `\x1b[${extraLines}A`;
    }

    buffer += "\x1b[?2026l";
    this.#cursorRow = Math.max(0, newLines.length - 1);
    this.#hardwareCursorRow = finalCursorRow;
    this.#maxLinesRendered = Math.max(this.#maxLinesRendered, newLines.length);
    this.#previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);
    buffer += this.#positionHardwareCursor(frame, width, newLines.length);
    this.#commitState(newLines, width, height);
    this.#terminal.write(buffer);
    this.#terminal.flush();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#terminal.write("\x1b[0 q\x1b[?25h");
      this.#terminal.flush();
    } finally {
      this.#terminal.restore();
    }
  }

  static #changedSpan(
    previous: readonly string[],
    current: readonly string[],
  ): [number, number] | null {
    let first = -1;
    let last = -1;
    const limit = Math.max(previous.length, current.length);
    for (let index = 0; index < limit; index += 1) {
      const oldLine = index < previous.length ? previous[index] : "";
      const newLine = index < current.length ? current[index] : "";
      if (oldLine === newLine) {
        continue;
      }
      if (first === -1) {
        first = index;
      }
      last = index;
    }
    if (first === -1) {
      return null;
    }
    return [first, last];
  }

  #positionHardwareCursor(
    frame: ScreenFrame,
    width: number,
    totalLines: number,
  ): string {
    if (frame.lines.length === 0 || totalLines <= 0) {
      return "";
    }
    const targetRow = Math.max(0, Math.min(frame.cursorRow, totalLines - 1));
    const targetCol = Math.max(0, Math.min(frame.cursorCol, Math.max(width - 1, 0)));
    const rowDelta = targetRow - this.#hardwareCursorRow;
    let buffer = "";
    if (rowDelta > 0) {
      buffer += `\x1b[${rowDelta}B`;
    } else if (rowDelta < 0) {
      buffer += `\x1b[${-rowDelta}A`;
    }
    buffer += `\x1b[${targetCol + 1}G`;
    this.#hardwareCursorRow = targetRow;
    return buffer;
  }

  #commitState(lines: readonly string[], width: number, height: number): void {
    this.#previousLines = [...lines];
    this.#previousWidth = width;
    this.#previousHeight = height;
  }

  static #validateLines(lines: readonly string[], width: number): void {
    lines.forEach((line, index) => {
      if (/[\r\n]/u.test(line)) {
        throw new Error(`rendered line ${index} contains a physical newline`);
      }
      const lineWidth = visibleWidth(line);
      if (lineWidth > width) {
        throw new Error(
          `rendered line ${index} exceeds terminal width (${lineWidth} > ${width})`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Visible-width string helpers (ANSI-aware, grapheme-cluster based)
// ---------------------------------------------------------------------------

/** Visible column width of a string, ignoring terminal control sequences. */
export function visibleWidth(text: string): number {
  if (!text) {
    return 0;
  }
  const stripped = stripTerminalControls(text).replace(/\t/g, "   ");
  let width = 0;
  for (const cluster of graphemeClusters(stripped)) {
    width += clusterWidth(cluster);
  }
  return width;
}

/** Truncate a styled ANSI string to a visible width, closing open SGR. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0 || !text) {
    return "";
  }
  const result: string[] = [];
  const sgrPrefix: string[] = [];
  let used = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\x1b") {
      const end = consumeEscapeSequence(text, index);
      const sequence = text.slice(index, end);
      if (isSgrSequence(sequence)) {
        result.push(sequence);
        updateSgrPrefix(sgrPrefix, sequence);
      }
      index = end;
      continue;
    }
    const nextEscape = text.indexOf("\x1b", index);
    const end = nextEscape === -1 ? text.length : nextEscape;
    for (const cluster of graphemeClusters(text.slice(index, end))) {
      const [renderedCluster, widthOfCluster] = displayCluster(cluster);
      if (used + widthOfCluster > width) {
        if (sgrPrefix.length > 0) {
          result.push("\x1b[0m");
        }
        return result.join("");
      }
      result.push(renderedCluster);
      used += widthOfCluster;
    }
    index = end;
  }
  if (sgrPrefix.length > 0) {
    result.push("\x1b[0m");
  }
  return result.join("");
}

/** Word-independent hard wrap of a styled ANSI string to a visible width. */
export function wrapTextToWidth(text: string, width: number): string[] {
  const targetWidth = Math.max(1, width);
  const rows: string[] = [];
  const sourceLines = text.split(/\r\n|\n|\r/);
  for (const sourceLine of sourceLines.length > 0 ? sourceLines : [""]) {
    let rowParts: string[] = [];
    let rowWidth = 0;
    const sgrPrefix: string[] = [];

    const finishRow = (): void => {
      if (sgrPrefix.length > 0) {
        rowParts.push("\x1b[0m");
      }
      rows.push(rowParts.join(""));
    };

    let index = 0;
    while (index < sourceLine.length) {
      if (sourceLine[index] === "\x1b") {
        const end = consumeEscapeSequence(sourceLine, index);
        const sequence = sourceLine.slice(index, end);
        if (isSgrSequence(sequence)) {
          rowParts.push(sequence);
          updateSgrPrefix(sgrPrefix, sequence);
        }
        index = end;
        continue;
      }

      const nextEscape = sourceLine.indexOf("\x1b", index);
      const end = nextEscape === -1 ? sourceLine.length : nextEscape;
      for (const cluster of graphemeClusters(sourceLine.slice(index, end))) {
        const [renderedCluster, widthOfCluster] = displayCluster(cluster);
        if (rowWidth > 0 && rowWidth + widthOfCluster > targetWidth) {
          finishRow();
          rowParts = [...sgrPrefix];
          rowWidth = 0;
        }
        if (widthOfCluster > targetWidth) {
          continue;
        }
        rowParts.push(renderedCluster);
        rowWidth += widthOfCluster;
      }
      index = end;
    }
    finishRow();
  }
  return rows;
}

/** Remove all terminal escape sequences from a string. */
export function stripTerminalControls(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "\x1b") {
      result += text[index];
      index += 1;
      continue;
    }
    index = consumeEscapeSequence(text, index);
  }
  return result;
}

function consumeEscapeSequence(text: string, start: number): number {
  if (start + 1 >= text.length) {
    return start + 1;
  }
  const marker = text[start + 1];
  if (marker === "[") {
    let index = start + 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return index + 1;
      }
      index += 1;
    }
    return text.length;
  }
  if (marker === "]") {
    return consumeStringSequence(text, start + 2, true);
  }
  if (marker === "P") {
    return consumeStringSequence(text, start + 2, false);
  }
  if (marker === "_") {
    return consumeStringSequence(text, start + 2, true);
  }
  return start + 2;
}

function consumeStringSequence(
  text: string,
  start: number,
  allowBel: boolean,
): number {
  let index = start;
  while (index < text.length) {
    if (allowBel && text[index] === "\x07") {
      return index + 1;
    }
    if (text.slice(index, index + 2) === "\x1b\\") {
      return index + 2;
    }
    index += 1;
  }
  return text.length;
}

function isSgrSequence(sequence: string): boolean {
  return sequence.startsWith("\x1b[") && sequence.endsWith("m");
}

function updateSgrPrefix(prefix: string[], sequence: string): void {
  const params = sequence
    .slice(2, -1)
    .replace(/:/g, ";")
    .split(";")
    .filter((part) => part.length > 0);
  if (params.length === 0 || params.every((param) => param === "0")) {
    prefix.length = 0;
    return;
  }
  if (params.includes("0")) {
    prefix.splice(0, prefix.length, sequence);
    return;
  }
  prefix.push(sequence);
}

function displayCluster(cluster: string): [string, number] {
  if (cluster === "\t") {
    return ["   ", 3];
  }
  return [cluster, clusterWidth(cluster)];
}

// ---------------------------------------------------------------------------
// Grapheme clusters and display width
// ---------------------------------------------------------------------------

const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

/** Split a string into extended grapheme clusters. */
export function graphemeClusters(text: string): string[] {
  const clusters: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(text)) {
    clusters.push(segment);
  }
  return clusters;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/** Visible cell width of one grapheme cluster (emoji/ZWJ sequences count 2). */
export function clusterWidth(cluster: string): number {
  if (!cluster) {
    return 0;
  }
  if (
    cluster.includes("‍") ||
    cluster.includes("️") ||
    [...cluster].some((char) =>
      isRegionalIndicator(char.codePointAt(0) as number),
    )
  ) {
    return 2;
  }
  let width = 0;
  for (const char of cluster) {
    width += charCellWidth(char);
  }
  return Math.max(0, width);
}

/** Terminal cell width of a single code point (wcwidth equivalent). */
export function charCellWidth(char: string): number {
  const cp = char.codePointAt(0) as number;
  if (cp === 0x200b || (cp >= 0x200c && cp <= 0x200f)) {
    return 0;
  }
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
    return 0;
  }
  if (isZeroWidth(cp)) {
    return 0;
  }
  if (isWide(cp)) {
    return 2;
  }
  return 1;
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    cp === 0x05bf ||
    (cp >= 0x05c1 && cp <= 0x05c2) ||
    (cp >= 0x05c4 && cp <= 0x05c5) ||
    cp === 0x05c7 ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x0e31 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    cp === 0x200d ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    (cp >= 0x26fa && cp <= 0x26fd) ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    (cp >= 0x3000 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x16fe4) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}
