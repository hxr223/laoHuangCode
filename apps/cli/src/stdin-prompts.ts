import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { enterTerminalRawMode, PromptCancelledError, PromptEofError } from "@laohuang/tui";

type PromptInput = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/** One stdin owner for startup questions and the plain REPL. */
export class StdinPrompts {
  readonly #input: PromptInput;
  #active = false;
  #skipLf = false;

  constructor(input: PromptInput) {
    this.#input = input;
  }

  async prompt(message: string, output: Pick<Writable, "write">, secret = false): Promise<string> {
    const input = this.#input;
    if (this.#active || input.listenerCount("data") > 0 || input.listenerCount("readable") > 0) {
      throw new Error("stdin is already in use by another input reader");
    }
    if (input.errored) throw input.errored;
    if (input.readableEnded || input.destroyed) throw new PromptEofError();
    this.#active = true;
    const raw = Boolean(secret && input.isTTY && input.setRawMode);

    return new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder("utf8");
      let answer = "";
      let settled = false;
      let restoreRawMode: (() => void) | undefined;

      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        input.pause();
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("close", onClose);
        input.removeListener("error", onError);
        process.removeListener("SIGINT", onInterrupt);
        try {
          restoreRawMode?.();
        } catch (restoreError) {
          error = error === undefined ? restoreError
            : new AggregateError([error, restoreError], "Input and terminal restoration failed");
        }
        this.#active = false;
        try {
          if (restoreRawMode) output.write("\n");
        } catch (outputError) {
          error ??= outputError;
        }
        if (error !== undefined) reject(error);
        else resolve(answer);
      };

      const onData = (data: Buffer | string): void => {
        try {
          const bytes = typeof data === "string" ? Buffer.from(data) : data;
          for (let index = 0; index < bytes.length; index++) {
            const value = bytes[index]!;
            if (this.#skipLf) {
              this.#skipLf = false;
              if (value === 0x0a) continue;
            }
            if (raw && (value === 0x03 || value === 0x04)) {
              finish(value === 0x03 ? new PromptCancelledError() : new PromptEofError());
              return;
            }
            if (value === 0x0a || value === 0x0d) {
              answer += decoder.end();
              if (value === 0x0d) {
                if (bytes[index + 1] === 0x0a) index++;
                else this.#skipLf = index + 1 === bytes.length;
              }
              // Keep typeahead in the stream for the next prompt or TUI owner.
              input.pause();
              if (index + 1 < bytes.length) input.unshift(bytes.subarray(index + 1));
              finish();
              return;
            }
            if (raw && (value === 0x7f || value === 0x08)) {
              answer = [...answer].slice(0, -1).join("");
            } else {
              answer += decoder.write(bytes.subarray(index, index + 1));
            }
          }
        } catch (error) {
          finish(error);
        }
      };
      const onEnd = (): void => {
        answer += decoder.end();
        finish(!raw && answer ? undefined : new PromptEofError());
      };
      const onClose = (): void => finish(new PromptEofError());
      const onError = (error: Error): void => finish(error);
      const onInterrupt = (): void => finish(new PromptCancelledError());

      try {
        if (raw) restoreRawMode = enterTerminalRawMode(input);
        if (message) output.write(message);
        if (input.isTTY) process.on("SIGINT", onInterrupt);
        input.on("data", onData);
        input.on("end", onEnd);
        input.on("close", onClose);
        input.on("error", onError);
        input.resume();
      } catch (error) {
        finish(error);
      }
    });
  }
}
