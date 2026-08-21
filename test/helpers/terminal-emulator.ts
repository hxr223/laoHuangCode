/**
 * Small ANSI terminal semantics emulator for renderer tests.
 *
 * Port of tests/terminal_emulator.py: models just enough real-terminal
 * behavior (scrolling viewport, pending wrap, CSI cursor movement, erase)
 * to assert on the semantic effect of renderer byte streams.
 */
export class TerminalEmulator {
  readonly columns: number;
  readonly rows: number;

  #screen: string[];
  #scrollback: string[] = [];
  #cursorRow = 0;
  #cursorColumn = 0;
  #pendingWrap = false;

  constructor(options: { columns: number; rows: number }) {
    const { columns, rows } = options;
    if (columns < 1 || rows < 1) {
      throw new Error("terminal size must be positive");
    }
    this.columns = columns;
    this.rows = rows;
    this.#screen = Array.from({ length: rows }, () => "");
  }

  get cursorRow(): number {
    return this.#cursorRow;
  }

  get cursorColumn(): number {
    return this.#cursorColumn;
  }

  get viewportTop(): number {
    return this.#scrollback.length;
  }

  get scrollback(): string[] {
    return [...this.#scrollback];
  }

  get viewportLines(): string[] {
    return this.#screen.map((line) => line.replace(/\s+$/u, ""));
  }

  get logicalLines(): string[] {
    return [...this.scrollback, ...this.viewportLines];
  }

  write(data: string): void {
    const chars = [...data];
    let index = 0;
    while (index < chars.length) {
      const char = chars[index] as string;
      if (char === "\x1b") {
        index = this.#consumeEscape(chars, index);
        continue;
      }
      if (char === "\r") {
        this.#carriageReturn();
      } else if (char === "\n") {
        this.#lineFeed();
      } else if (char === "\b") {
        this.#pendingWrap = false;
        this.#cursorColumn = Math.max(0, this.#cursorColumn - 1);
      } else if (char >= " ") {
        this.#print(char);
      } else {
        this.#pendingWrap = false;
      }
      index += 1;
    }
  }

  #consumeEscape(chars: string[], start: number): number {
    if (start + 1 >= chars.length) {
      this.#pendingWrap = false;
      return start + 1;
    }
    const marker = chars[start + 1];
    if (marker === "[") {
      let end = start + 2;
      while (
        end < chars.length &&
        !("@" <= (chars[end] as string) && (chars[end] as string) <= "~")
      ) {
        end += 1;
      }
      if (end >= chars.length) {
        this.#pendingWrap = false;
        return chars.length;
      }
      this.#applyCsi(chars.slice(start + 2, end).join(""), chars[end] as string);
      return end + 1;
    }
    if (marker === "]" || marker === "P" || marker === "_") {
      return this.#consumeStringSequence(chars, start + 2);
    }
    this.#pendingWrap = false;
    return start + 2;
  }

  #consumeStringSequence(chars: string[], start: number): number {
    let index = start;
    while (index < chars.length) {
      if (chars[index] === "\x07") {
        this.#pendingWrap = false;
        return index + 1;
      }
      if (chars[index] === "\x1b" && chars[index + 1] === "\\") {
        this.#pendingWrap = false;
        return index + 2;
      }
      index += 1;
    }
    this.#pendingWrap = false;
    return chars.length;
  }

  #applyCsi(params: string, final: string): void {
    if (final === "h" || final === "l") {
      this.#pendingWrap = false;
      return;
    }
    if (final === "m") {
      this.#pendingWrap = false;
      return;
    }
    if (final === "A") {
      this.#moveRows(-TerminalEmulator.#firstParam(params, 1));
    } else if (final === "B") {
      this.#moveRows(TerminalEmulator.#firstParam(params, 1));
    } else if (final === "C") {
      this.#moveColumns(TerminalEmulator.#firstParam(params, 1));
    } else if (final === "D") {
      this.#moveColumns(-TerminalEmulator.#firstParam(params, 1));
    } else if (final === "G") {
      this.#setColumn(TerminalEmulator.#firstParam(params, 1) - 1);
    } else if (final === "H" || final === "f") {
      const [row, column] = TerminalEmulator.#rowColumnParams(params);
      this.#setPosition(row - 1, column - 1);
    } else if (final === "K" && TerminalEmulator.#firstParam(params, 0) === 2) {
      this.#pendingWrap = false;
      this.#screen[this.#cursorRow] = "";
    } else if (final === "J") {
      const mode = TerminalEmulator.#firstParam(params, 0);
      this.#pendingWrap = false;
      if (mode === 2) {
        this.#screen = Array.from({ length: this.rows }, () => "");
      } else if (mode === 3) {
        this.#scrollback = [];
      }
    } else {
      this.#pendingWrap = false;
    }
  }

  static #firstParam(params: string, fallback: number): number {
    const cleaned = params.replace(/^\?/u, "");
    const first = cleaned.split(";", 1)[0] as string;
    if (!first) {
      return fallback;
    }
    const value = Number.parseInt(first, 10);
    return Number.isNaN(value) ? fallback : value;
  }

  static #rowColumnParams(params: string): [number, number] {
    const values = params.replace(/^\?/u, "").split(";");
    return [
      TerminalEmulator.#positionValue(values, 0),
      TerminalEmulator.#positionValue(values, 1),
    ];
  }

  static #positionValue(values: string[], index: number): number {
    const raw = values[index];
    if (raw === undefined || raw === "") {
      return 1;
    }
    const value = Number.parseInt(raw, 10);
    if (Number.isNaN(value)) {
      return 1;
    }
    return Math.max(1, value);
  }

  #print(char: string): void {
    if (this.#pendingWrap) {
      this.#lineFeed();
      this.#cursorColumn = 0;
    }
    this.#putChar(char);
    if (this.#cursorColumn >= this.columns - 1) {
      this.#cursorColumn = this.columns - 1;
      this.#pendingWrap = true;
    } else {
      this.#cursorColumn += 1;
      this.#pendingWrap = false;
    }
  }

  #putChar(char: string): void {
    let cells = [...(this.#screen[this.#cursorRow] as string)];
    while (cells.length < this.#cursorColumn) {
      cells.push(" ");
    }
    if (cells.length === this.#cursorColumn) {
      cells.push(char);
    } else {
      cells[this.#cursorColumn] = char;
    }
    this.#screen[this.#cursorRow] = cells.slice(0, this.columns).join("");
  }

  #carriageReturn(): void {
    this.#pendingWrap = false;
    this.#cursorColumn = 0;
  }

  #lineFeed(): void {
    this.#pendingWrap = false;
    if (this.#cursorRow === this.rows - 1) {
      const top = this.#screen.shift() as string;
      this.#scrollback.push(top.replace(/\s+$/u, ""));
      this.#screen.push("");
    } else {
      this.#cursorRow += 1;
    }
  }

  #moveRows(amount: number): void {
    this.#pendingWrap = false;
    this.#cursorRow = Math.min(Math.max(this.#cursorRow + amount, 0), this.rows - 1);
  }

  #moveColumns(amount: number): void {
    this.#pendingWrap = false;
    this.#cursorColumn = Math.min(
      Math.max(this.#cursorColumn + amount, 0),
      this.columns - 1,
    );
  }

  #setColumn(column: number): void {
    this.#pendingWrap = false;
    this.#cursorColumn = Math.min(Math.max(column, 0), this.columns - 1);
  }

  #setPosition(row: number, column: number): void {
    this.#pendingWrap = false;
    this.#cursorRow = Math.min(Math.max(row, 0), this.rows - 1);
    this.#cursorColumn = Math.min(Math.max(column, 0), this.columns - 1);
  }
}
