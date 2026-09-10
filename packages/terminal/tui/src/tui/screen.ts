import { BoundedTerminalWriter } from "./terminal-writer.ts";
import { RenderWidthError } from "./render-diagnostics.ts";
import { visibleWidth, normalizeTerminalOutput } from "./terminal-text.ts";
export { charCellWidth, clusterWidth, graphemeClusters, visibleWidth, truncateToWidth, wrapTextToWidth, stripTerminalControls, normalizeTerminalOutput, sliceByColumn } from "./terminal-text.ts";

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
export class MainScreenRenderer {
  #terminal: TerminalDriver;
  #previousLines: readonly string[] = [];
  #previousSources: readonly string[] = [];
  #previousWidth = 0;
  #previousHeight = 0;
  #previousViewportTop = 0;
  #cursorRow = 0;
  #hardwareCursorRow = 0;
  #maxLinesRendered = 0;
  #clearOnShrink: boolean;
  #termux: boolean;
  #closed = false;

  constructor(
    terminal: TerminalDriver,
    env: Record<string, string | undefined> = process.env,
  ) {
    this.#terminal = terminal;
    this.#clearOnShrink = env.LAOHUANG_CLEAR_ON_SHRINK === "1";
    this.#termux = Boolean(env.TERMUX_VERSION);
  }

  render(frame: ScreenFrame): void {
    if (this.#closed) {
      return;
    }

    const size = this.#terminal.getSize();
    const width = Math.max(1, size.columns);
    const height = Math.max(1, size.rows);
    const sources = frame.lines;
    const newLines = sources.map((text, index) => this.#previousSources[index] === text ? this.#previousLines[index]! : normalizeTerminalOutput(text));
    const widthChanged = this.#previousWidth !== 0 && this.#previousWidth !== width;
    const heightChanged =
      this.#previousHeight !== 0 && this.#previousHeight !== height;
    // An unchanged line has already passed validation at this terminal size.
    MainScreenRenderer.#validateLines(
      newLines,
      width,
      widthChanged || heightChanged ? [] : this.#previousLines,
    );
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
      const buffer = new BoundedTerminalWriter(text => this.#terminal.write(text));
      buffer.append("\x1b[?2026h");
      if (clear) {
        buffer.append("\x1b[2J\x1b[H\x1b[3J");
      }
      newLines.forEach((line, index) => {
        if (index > 0) {
          buffer.append("\r\n");
        }
        buffer.append(line);
      });
      buffer.append("\x1b[?2026l");
      this.#cursorRow = Math.max(0, newLines.length - 1);
      this.#hardwareCursorRow = this.#cursorRow;
      if (clear) {
        this.#maxLinesRendered = newLines.length;
      } else {
        this.#maxLinesRendered = Math.max(this.#maxLinesRendered, newLines.length);
      }
      const bufferLength = Math.max(height, newLines.length);
      this.#previousViewportTop = Math.max(0, bufferLength - height);
      buffer.append(this.#positionHardwareCursor(frame, width, newLines.length));
      this.#commitState(newLines, width, height);
      this.#previousSources = [...sources];
      buffer.flush();
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
    if (widthChanged || (heightChanged && !this.#termux)) {
      fullRender(true);
      return;
    }
    if (this.#clearOnShrink && newLines.length < this.#maxLinesRendered) {
      fullRender(true);
      return;
    }

    const span = MainScreenRenderer.#changedSpan(this.#previousLines, newLines);
    if (span === null) {
      this.#previousViewportTop = prevViewportTop;
      const cursorBuffer = this.#positionHardwareCursor(frame, width, newLines.length);
      this.#previousSources = [...sources];
      this.#previousHeight = height;
      if (cursorBuffer) {
        this.#terminal.write(cursorBuffer);
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
      const buffer = new BoundedTerminalWriter(text => this.#terminal.write(text));
      buffer.append("\x1b[?2026h");
      const targetRow = Math.max(0, newLines.length - 1);
      if (targetRow < prevViewportTop) {
        fullRender(true);
        return;
      }
      const lineDiff = computeLineDiff(targetRow);
      if (lineDiff > 0) {
        buffer.append(`\x1b[${lineDiff}B`);
      } else if (lineDiff < 0) {
        buffer.append(`\x1b[${-lineDiff}A`);
      }
      buffer.append("\r");
      const extraLines = this.#previousLines.length - newLines.length;
      if (extraLines > height) {
        fullRender(true);
        return;
      }
      const clearStartOffset = newLines.length === 0 ? 0 : 1;
      if (extraLines > 0 && clearStartOffset > 0) {
        buffer.append(`\x1b[${clearStartOffset}B`);
      }
      for (let index = 0; index < extraLines; index += 1) {
        buffer.append("\r\x1b[2K");
        if (index < extraLines - 1) {
          buffer.append("\x1b[1B");
        }
      }
      const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
      if (moveBack > 0) {
        buffer.append(`\x1b[${moveBack}A`);
      }
      buffer.append("\x1b[?2026l");
      this.#cursorRow = targetRow;
      this.#hardwareCursorRow = targetRow;
      buffer.append(this.#positionHardwareCursor(frame, width, newLines.length));
      this.#previousViewportTop = prevViewportTop;
      this.#commitState(newLines, width, height);
      this.#previousSources = [...sources];
      buffer.flush();
      this.#terminal.flush();
      return;
    }

    if (firstChanged < prevViewportTop) {
      fullRender(true);
      return;
    }

    const buffer = new BoundedTerminalWriter(text => this.#terminal.write(text));
      buffer.append("\x1b[?2026h");
    const prevViewportBottom = prevViewportTop + height - 1;
    const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
    if (moveTargetRow > prevViewportBottom) {
      const currentScreenRow = Math.max(
        0,
        Math.min(height - 1, hardwareCursorRow - prevViewportTop),
      );
      const moveToBottom = height - 1 - currentScreenRow;
      if (moveToBottom > 0) {
        buffer.append(`\x1b[${moveToBottom}B`);
      }
      const scroll = moveTargetRow - prevViewportBottom;
      buffer.append("\r\n".repeat(scroll));
      viewportTop += scroll;
      hardwareCursorRow = moveTargetRow;
    }

    const lineDiff = computeLineDiff(moveTargetRow);
    if (lineDiff > 0) {
      buffer.append(`\x1b[${lineDiff}B`);
    } else if (lineDiff < 0) {
      buffer.append(`\x1b[${-lineDiff}A`);
    }
    buffer.append(appendStart ? "\r\n" : "\r");

    const renderEnd = Math.min(lastChanged, newLines.length - 1);
    for (let index = firstChanged; index <= renderEnd; index += 1) {
      if (index > firstChanged) {
        buffer.append("\r\n");
      }
      buffer.append("\x1b[2K");
      buffer.append(newLines[index] as string);
    }

    let finalCursorRow = renderEnd;
    if (this.#previousLines.length > newLines.length) {
      if (renderEnd < newLines.length - 1) {
        const moveDown = newLines.length - 1 - renderEnd;
        buffer.append(`\x1b[${moveDown}B`);
        finalCursorRow = newLines.length - 1;
      }
      const extraLines = this.#previousLines.length - newLines.length;
      for (let index = newLines.length; index < this.#previousLines.length; index += 1) {
        buffer.append("\r\n\x1b[2K");
      }
      buffer.append(`\x1b[${extraLines}A`);
    }

    buffer.append("\x1b[?2026l");
    this.#cursorRow = Math.max(0, newLines.length - 1);
    this.#hardwareCursorRow = finalCursorRow;
    this.#maxLinesRendered = Math.max(this.#maxLinesRendered, newLines.length);
    this.#previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);
    buffer.append(this.#positionHardwareCursor(frame, width, newLines.length));
    this.#commitState(newLines, width, height);
      this.#previousSources = [...sources];
    buffer.flush();
    this.#terminal.flush();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#terminal.write("\x1b[?2026l\x1b[0m\x1b]8;;\x07\x1b[0 q\x1b[?25h");
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

  static #validateLines(lines: readonly string[], width: number, previous: readonly string[]): void {
    lines.forEach((line, index) => {
      if (previous[index] === line) return;
      if (/[\r\n]/u.test(line)) {
        throw new Error(`rendered line ${index} contains a physical newline`);
      }
      const lineWidth = visibleWidth(line);
      if (lineWidth > width) {
        throw new RenderWidthError(width, lineWidth, line, `screen row ${index}`);
      }
    });
  }
}
