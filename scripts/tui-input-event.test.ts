import test from "node:test";
import assert from "node:assert/strict";

import {
  BufferedInputKind,
  InputActionKind,
  RawInputDecoder,
  StdinBuffer,
  inputAction,
  type BufferedPasteInput,
} from "../packages/terminal/tui/src/tui/editor.ts";
import { toTuiInputEvent } from "../packages/terminal/tui/src/tui/input.ts";

test("normalizes keyboard actions into neutral key events", () => {
  const decoder = new RawInputDecoder();
  const actions = [
    ...decoder.feed(Buffer.from("\r")),
    ...decoder.feed(Buffer.from("\t")),
    ...decoder.feed(Buffer.from("\x03")),
    ...decoder.feed(Buffer.from("\x1b[A")),
    ...decoder.feed(Buffer.from("\x1b[B")),
    ...decoder.feed(Buffer.from("\x1b[C")),
    ...decoder.feed(Buffer.from("\x1b[D")),
    ...decoder.feed(Buffer.from("\x1b")),
  ];
  actions.push(...decoder.flush());

  assert.deepEqual(actions.map(toTuiInputEvent), [
    { type: "key", key: { id: "enter", text: null, ctrl: false, alt: false, shift: false } },
    { type: "key", key: { id: "tab", text: null, ctrl: false, alt: false, shift: false } },
    { type: "key", key: { id: "ctrl_c", text: null, ctrl: true, alt: false, shift: false } },
    { type: "key", key: { id: "up", text: null, ctrl: false, alt: false, shift: false } },
    { type: "key", key: { id: "down", text: null, ctrl: false, alt: false, shift: false } },
    { type: "key", key: { id: "right", text: null, ctrl: false, alt: false, shift: false } },
    { type: "key", key: { id: "left", text: null, ctrl: false, alt: false, shift: false } },
    { type: "key", key: { id: "escape", text: null, ctrl: false, alt: false, shift: false } },
  ]);
});

test("normalizes inserted text and bracketed paste distinctly", () => {
  assert.deepEqual(toTuiInputEvent(inputAction(InputActionKind.Insert, "hello")), {
    type: "text",
    text: "hello",
  });

  const buffer = new StdinBuffer();
  const events = buffer.feed(Buffer.from("\x1b[200~one\ntwo\x1b[201~"));
  const paste = events.find(
    (event): event is BufferedPasteInput =>
      event.kind === BufferedInputKind.Paste,
  );
  assert.ok(paste);
  assert.deepEqual(toTuiInputEvent(paste), {
    type: "paste",
    text: "one\ntwo",
  });
});

test("submit remains the live action while adapting as Enter", () => {
  const action = inputAction(InputActionKind.Submit);

  assert.equal(action.kind, InputActionKind.Submit);
  assert.deepEqual(toTuiInputEvent(action), {
    type: "key",
    key: { id: "enter", text: null, ctrl: false, alt: false, shift: false },
  });
});
