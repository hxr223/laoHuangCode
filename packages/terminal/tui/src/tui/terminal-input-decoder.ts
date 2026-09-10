import type { PendingInputKind } from "./terminal-session.ts";
import {
  BufferedInputKind,
  InputActionKind,
  RawInputDecoder,
  StdinBuffer,
  TerminalInputFilter,
  inputAction,
  type InputAction,
  type TerminalInputFilterOptions,
} from "./editor.ts";
import type { InputDecoderHooks, InputDecoderLike } from "./contracts.ts";

export interface TerminalInputDecoderOptions
  extends Pick<TerminalInputFilterOptions, "isAppleTerminal" | "shiftPressed"> {}

/** Canonical interactive input pipeline: buffer, filter, then decode. */
export class TerminalInputDecoder implements InputDecoderLike {
  #stdinBuffer = new StdinBuffer();
  #filter: TerminalInputFilter;
  #decoder = new RawInputDecoder();

  constructor(
    hooks: InputDecoderHooks,
    options: TerminalInputDecoderOptions = {},
  ) {
    this.#filter = new TerminalInputFilter({
      ...options,
      enableModifyOtherKeys: () => {
        hooks.enableModifyOtherKeys();
      },
      disableModifyOtherKeys: () => {
        hooks.disableModifyOtherKeys();
      },
    });
  }

  get kittyProtocolActive(): boolean {
    return this.#filter.kittyProtocolActive;
  }

  set kittyProtocolActive(value: boolean) {
    this.#filter.kittyProtocolActive = value;
  }

  pendingKind(): PendingInputKind {
    return this.#filter.negotiationPending ? "negotiation" : this.#stdinBuffer.pendingKind();
  }

  feed(data: Uint8Array): InputAction[] {
    const actions: InputAction[] = [];
    for (const event of this.#stdinBuffer.feed(data)) {
      if (event.kind === BufferedInputKind.Paste) {
        actions.push(
          inputAction(InputActionKind.Insert, event.data.toString("utf8")),
        );
        continue;
      }
      for (const sequence of this.#filter.feed(event.data)) {
        actions.push(...this.#decoder.feed(sequence));
      }
    }
    return actions;
  }

  flush(): InputAction[] {
    const actions: InputAction[] = [];
    for (const event of this.#stdinBuffer.flush()) {
      if (event.kind === BufferedInputKind.Paste) {
        actions.push(
          inputAction(InputActionKind.Insert, event.data.toString("utf8")),
        );
        continue;
      }
      for (const sequence of this.#filter.feed(event.data)) {
        actions.push(...this.#decoder.feed(sequence));
      }
    }
    for (const sequence of this.#filter.flush()) {
      actions.push(...this.#decoder.feed(sequence));
    }
    actions.push(...this.#decoder.flush());
    return actions;
  }

  clear(): void {
    this.#stdinBuffer.clear();
    this.#filter.clear();
    this.#decoder = new RawInputDecoder();
  }
}
