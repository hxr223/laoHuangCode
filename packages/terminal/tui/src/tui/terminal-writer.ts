/** Bounded terminal writes without splitting UTF-16 surrogate pairs. */
export class BoundedTerminalWriter {
  static readonly MAX_CHARS = 1024 * 1024;
  #buffer = "";
  readonly #write: (text: string) => void;

  constructor(write: (text: string) => void) { this.#write = write; }

  append(text: string): void {
    let offset = 0;
    while (offset < text.length) {
      const capacity = BoundedTerminalWriter.MAX_CHARS - this.#buffer.length;
      let end = Math.min(text.length, offset + capacity);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end--;
      if (end === offset) { this.flush(); continue; }
      this.#buffer += text.slice(offset, end);
      offset = end;
      if (this.#buffer.length === BoundedTerminalWriter.MAX_CHARS) this.flush();
    }
  }

  flush(): void {
    if (!this.#buffer) return;
    this.#write(this.#buffer);
    this.#buffer = "";
  }
}
