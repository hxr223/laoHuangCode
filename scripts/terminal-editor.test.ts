import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BufferedInputKind,
  EditorState,
  InputActionKind,
  RawInputDecoder,
  StdinBuffer,
  TerminalInputFilter,
  inputAction,
  type CompletionItem,
  type InputAction,
} from "../src/terminal/editor.ts";
import { makeKeyInput } from "../src/keybindings/key-id.ts";

/**
 * Mirror of the Python test helper: StdinBuffer -> TerminalInputFilter ->
 * RawInputDecoder, with bracketed-paste events becoming INSERT actions.
 */
function decodeBuffered(
  chunks: Uint8Array[],
  filter?: TerminalInputFilter,
): InputAction[] {
  const buffer = new StdinBuffer();
  const inputFilter = filter ?? new TerminalInputFilter();
  const decoder = new RawInputDecoder();
  const actions: InputAction[] = [];
  for (const chunk of chunks) {
    for (const event of buffer.feed(chunk)) {
      if (event.kind === BufferedInputKind.Paste) {
        actions.push(
          inputAction(InputActionKind.Insert, event.data.toString("utf8")),
        );
        continue;
      }
      for (const sequence of inputFilter.feed(event.data)) {
        actions.push(...decoder.feed(sequence));
      }
    }
  }
  return actions;
}

/**
 * Build the completion a CommandRegistry would return for a slash command.
 * (src/commands.ts is ported by another workstream; CompletionItem is the
 * widget-independent contract shared with it.)
 */
function commandCompletion(name: string, description: string, text: string): CompletionItem {
  return { value: name, description, start: -text.length };
}

test("decoder distinguishes submit, alt+enter and ctrl+d", () => {
  const decoder = new RawInputDecoder();

  assert.deepEqual(decoder.feed(Buffer.from("\r")), [
    inputAction(InputActionKind.Submit),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b\r")), [
    inputAction(
      InputActionKind.Key,
      "",
      { id: "enter", text: null, ctrl: false, alt: true, shift: false },
    ),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x04")), [
    inputAction(InputActionKind.Eof),
  ]);
});

test("decoder emits ctrl+c as neutral key input", () => {
  const decoder = new RawInputDecoder();

  assert.deepEqual(decoder.feed(Buffer.from("\x03")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("ctrl_c", { ctrl: true })),
  ]);
});

test("decoder emits enhanced alt enter and shift tab as neutral keys", () => {
  const decoder = new RawInputDecoder();

  assert.deepEqual(decoder.feed(Buffer.from("\x1b[13;3u")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("enter", { alt: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[27;3;13~")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("enter", { alt: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[9;2u")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("tab", { shift: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[27;2;9~")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("tab", { shift: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[13;67u")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("enter", { alt: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[13;3:1u")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("enter", { alt: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[9;66u")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("tab", { shift: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[9;2:1u")), [
    inputAction(InputActionKind.Key, "", makeKeyInput("tab", { shift: true })),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[13;3:3u")), []);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[9;2:3u")), []);
});

test("decoder keeps shifted enter as editor newline", () => {
  const decoder = new RawInputDecoder();

  assert.deepEqual(decoder.feed(Buffer.from("\x1b[13;2u")), [
    inputAction(InputActionKind.Newline),
  ]);
});

test("decoder drops unknown controls and unrecognized csi as units", () => {
  const decoder = new RawInputDecoder();

  assert.deepEqual(decoder.feed(Buffer.concat([Buffer.from([1]), Buffer.from("x")])), [
    inputAction(InputActionKind.Insert, "x"),
  ]);
  assert.deepEqual(decoder.feed(Buffer.from("\x1b[1")), []);
  assert.deepEqual(decoder.feed(Buffer.from("Aok")), [
    inputAction(InputActionKind.Insert, "ok"),
  ]);
});

test("decoder flushes standalone escape as completion dismissal", () => {
  const decoder = new RawInputDecoder();

  assert.deepEqual(decoder.feed(Buffer.from("\x1b")), []);
  assert.deepEqual(decoder.flush(), [inputAction(InputActionKind.Dismiss)]);
});

test("stdin filter drops split device attributes response", () => {
  const actions = decodeBuffered([Buffer.from("\x1b"), Buffer.from("[?1;2c")]);

  assert.deepEqual(actions, []);
});

test("stdin filter drops abandoned prefix before real input", () => {
  const typed = decodeBuffered([Buffer.from("\x1b[?1;"), Buffer.from("a")]);
  const arrow = decodeBuffered([Buffer.from("\x1b[?1;"), Buffer.from("\x1b[A")]);

  assert.deepEqual(typed, [inputAction(InputActionKind.Insert, "a")]);
  assert.deepEqual(arrow, [inputAction(InputActionKind.HistoryUp)]);
});

test("stdin buffer emits split bracketed paste as content only", () => {
  const actions = decodeBuffered([
    Buffer.from("\x1b[200~hello\n"),
    Buffer.from("world\x1b[201~"),
  ]);

  assert.deepEqual(actions, [inputAction(InputActionKind.Insert, "hello\nworld")]);
});

test("stdin buffer keeps ordinary arrow keys mapped", () => {
  const actions = decodeBuffered([Buffer.from("\x1b"), Buffer.from("[A")]);

  assert.deepEqual(actions, [inputAction(InputActionKind.HistoryUp)]);
});

test("stdin buffer flushes standalone escape as dismissal", () => {
  const buffer = new StdinBuffer();
  const inputFilter = new TerminalInputFilter();
  const decoder = new RawInputDecoder();

  assert.deepEqual(buffer.feed(Buffer.from("\x1b")), []);
  const actions: InputAction[] = [];
  for (const event of buffer.flush()) {
    for (const sequence of inputFilter.feed(event.data)) {
      actions.push(...decoder.feed(sequence));
    }
  }
  actions.push(...decoder.flush());

  assert.deepEqual(actions, [inputAction(InputActionKind.Dismiss)]);
});

test("stdin buffer preserves cjk insert", () => {
  const actions = decodeBuffered([Buffer.from("你好", "utf8")]);

  assert.equal(actions.map((action) => action.text).join(""), "你好");
});

test("bracketed paste newlines insert instead of submitting", () => {
  const editor = new EditorState();
  const actions = decodeBuffered([Buffer.from("\x1b[200~one\ntwo\x1b[201~")]);

  const effects = actions.map((action) =>
    editor.apply(action, { runtimeActive: false }),
  );

  assert.equal(editor.text, "one\ntwo");
  assert.ok(effects.every((effect) => effect.submit === null));
});

test("apple terminal shift+enter normalizes to newline", () => {
  const filter = new TerminalInputFilter({
    isAppleTerminal: () => true,
    shiftPressed: () => true,
  });

  const actions = decodeBuffered([Buffer.from("\r")], filter);

  assert.deepEqual(actions, [inputAction(InputActionKind.Newline)]);
});

test("kitty release is filtered and repeat maps to printable", () => {
  const release = decodeBuffered([Buffer.from("\x1b[65;1:3u")]);
  const repeat = decodeBuffered([Buffer.from("\x1b[65;1:2u")]);

  assert.deepEqual(release, []);
  assert.deepEqual(repeat, [inputAction(InputActionKind.Insert, "A")]);
});

test("kitty arrow press, repeat and release", () => {
  const press = decodeBuffered([Buffer.from("\x1b[1;1A")]);
  const repeat = decodeBuffered([Buffer.from("\x1b[1;1:2C")]);
  const release = decodeBuffered([Buffer.from("\x1b[1;1:3A")]);

  assert.deepEqual(press, [inputAction(InputActionKind.HistoryUp)]);
  assert.deepEqual(repeat, [inputAction(InputActionKind.CursorRight)]);
  assert.deepEqual(release, []);
});

test("unmodified kitty printable suppresses raw duplicate", () => {
  const actions = decodeBuffered([Buffer.from("\x1b[97u"), Buffer.from("a")]);

  assert.deepEqual(actions, [inputAction(InputActionKind.Insert, "a")]);
});

test("unmodified kitty printable suppresses batched raw duplicate", () => {
  const actions = decodeBuffered([Buffer.from("\x1b[97u"), Buffer.from("ab")]);

  assert.deepEqual(actions, [
    inputAction(InputActionKind.Insert, "a"),
    inputAction(InputActionKind.Insert, "b"),
  ]);
});

test("high-bit meta byte is converted before buffering", () => {
  const actions = decodeBuffered([Buffer.from([0xe1])]);

  assert.deepEqual(actions, [inputAction(InputActionKind.Insert, "a")]);
});

test("editor keeps slash candidates and tab accepts first", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/e"), { runtimeActive: false });
  editor.setCompletions([commandCompletion("/exit", "退出程序", editor.text)]);

  const effect = editor.apply(inputAction(InputActionKind.Complete), {
    runtimeActive: false,
  });

  assert.equal(editor.text, "/exit");
  assert.equal(effect.submit, null);
});

test("editor submit records history", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "first"), { runtimeActive: false });

  const effect = editor.apply(inputAction(InputActionKind.Submit), {
    runtimeActive: false,
  });

  assert.equal(effect.submit, "first");
  assert.deepEqual(editor.history, ["first"]);
});

test("completion overlay enter accepts slash command and submits", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/"), { runtimeActive: false });
  editor.setCompletions([
    commandCompletion("/exit", "退出", "/"),
    commandCompletion("/help", "帮助", "/"),
  ]);

  editor.apply(inputAction(InputActionKind.HistoryDown), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.HistoryUp), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.HistoryDown), { runtimeActive: false });
  const submitted = editor.apply(inputAction(InputActionKind.Submit), {
    runtimeActive: false,
  });
  const empty = editor.apply(inputAction(InputActionKind.Submit), {
    runtimeActive: false,
  });

  assert.deepEqual(editor.history, ["/help"]);
  assert.equal(submitted.submit, "/help");
  assert.equal(empty.submit, null);
});

test("fully typed command submits instead of re-accepting the exact candidate", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/exit"), { runtimeActive: false });
  // The loop refreshes completions after every keystroke; an exact match is
  // still returned as a candidate, so the menu stays visible.
  editor.setCompletions([commandCompletion("/exit", "退出", editor.text)]);

  const effect = editor.apply(inputAction(InputActionKind.Submit), {
    runtimeActive: false,
  });

  assert.equal(effect.submit, "/exit");
  assert.deepEqual(editor.history, ["/exit"]);
});

test("partially typed command accepts the completion and submits on enter", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/e"), { runtimeActive: false });
  editor.setCompletions([commandCompletion("/exit", "退出", editor.text)]);

  const submitted = editor.apply(inputAction(InputActionKind.Submit), {
    runtimeActive: false,
  });

  assert.equal(submitted.submit, "/exit");
  assert.deepEqual(editor.history, ["/exit"]);
});

test("fully typed argument submits instead of re-accepting the exact candidate", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/model current"), {
    runtimeActive: false,
  });
  editor.setCompletions([
    { value: "current", description: "查看当前模型", start: -"current".length },
  ]);

  const effect = editor.apply(inputAction(InputActionKind.Submit), {
    runtimeActive: false,
  });

  assert.equal(effect.submit, "/model current");
});

test("escape closes completion and cursor motion cannot accept stale candidate", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/mo"), { runtimeActive: false });
  editor.setCompletions([commandCompletion("/model", "模型", editor.text)]);

  editor.apply(inputAction(InputActionKind.CursorLeft), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.Complete), { runtimeActive: false });

  assert.equal(editor.text, "/mo");
  editor.setCompletions([commandCompletion("/model", "模型", editor.text)]);
  editor.apply(inputAction(InputActionKind.Dismiss), { runtimeActive: false });
  assert.equal(editor.completionVisible, false);
});

test("text mutation closes completion before tab can use a stale offset", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/e"), { runtimeActive: false });
  editor.setCompletions([commandCompletion("/echo", "回显", editor.text)]);

  editor.apply(inputAction(InputActionKind.Insert, "x"), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.Complete), { runtimeActive: false });

  assert.equal(editor.text, "/ex");
  assert.equal(editor.completionVisible, false);
});

test("completion rows equal visible candidates", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "/"), { runtimeActive: false });
  editor.setCompletions([
    commandCompletion("/exit", "退出程序", "/"),
    commandCompletion("/help", "帮助", "/"),
  ]);

  assert.equal(editor.completions.length, 2);
  editor.apply(inputAction(InputActionKind.Insert, "x"), { runtimeActive: false });

  assert.equal(editor.completions.length, 0);
});

test("ctrl+c cancels when running and clears a non-empty editor when idle", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "draft"), { runtimeActive: false });

  const running = editor.apply(inputAction(InputActionKind.Cancel), {
    runtimeActive: true,
  });

  assert.equal(running.cancelRequested, true);
  assert.equal(editor.text, "draft");

  const idle = editor.apply(inputAction(InputActionKind.Cancel), {
    runtimeActive: false,
  });

  assert.equal(idle.cancelRequested, false);
  assert.equal(editor.text, "");
});

test("a second idle ctrl+c within the window exits (pi double-press)", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "draft"), { runtimeActive: false });

  const first = editor.apply(inputAction(InputActionKind.Cancel), {
    runtimeActive: false,
  });
  assert.equal(first.exitRequested, false);
  assert.equal(editor.text, "");

  const second = editor.apply(inputAction(InputActionKind.Cancel), {
    runtimeActive: false,
  });
  assert.equal(second.exitRequested, true);
});

test("a second idle ctrl+c after the window clears instead of exiting", () => {
  const originalNow = performance.now;
  let now = 1_000;
  performance.now = () => now;
  try {
    const editor = new EditorState();
    editor.apply(inputAction(InputActionKind.Cancel), { runtimeActive: false });
    now += EditorState.DOUBLE_CANCEL_EXIT_MS + 100;
    const second = editor.apply(inputAction(InputActionKind.Cancel), {
      runtimeActive: false,
    });
    assert.equal(second.exitRequested, false);
  } finally {
    performance.now = originalNow;
  }
});

test("ctrl+c while running does not arm the exit window", () => {
  const editor = new EditorState();
  const cancel = editor.apply(inputAction(InputActionKind.Cancel), {
    runtimeActive: true,
  });
  assert.equal(cancel.cancelRequested, true);

  // The task just stopped; an immediate idle ctrl+c must only clear, not exit.
  const after = editor.apply(inputAction(InputActionKind.Cancel), {
    runtimeActive: false,
  });
  assert.equal(after.exitRequested, false);
});

test("ctrl+d exits only for idle empty editor", () => {
  const editor = new EditorState();

  const running = editor.apply(inputAction(InputActionKind.Eof), {
    runtimeActive: true,
  });
  const idle = editor.apply(inputAction(InputActionKind.Eof), {
    runtimeActive: false,
  });

  assert.equal(running.exitRequested, false);
  assert.equal(running.notice, "A task is still running. Press Ctrl+C to cancel it.");
  assert.equal(idle.exitRequested, true);
});

test("ctrl+d on a non-empty idle editor asks to clear it first", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "x"), { runtimeActive: false });

  const effect = editor.apply(inputAction(InputActionKind.Eof), {
    runtimeActive: false,
  });

  assert.equal(effect.exitRequested, false);
  assert.equal(effect.notice, "Clear the editor before exiting.");
});

test("render lines places cursor on the newline row", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "first\n"), { runtimeActive: false });

  const { lines, cursorRow, cursorColumn } = editor.renderLines(20);

  assert.deepEqual(lines, ["❯ first", "  "]);
  assert.deepEqual([cursorRow, cursorColumn], [1, 2]);
});

test("render lines wraps cjk by terminal cell width", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "你好你"), { runtimeActive: false });

  const { lines, cursorRow, cursorColumn } = editor.renderLines(7);

  assert.deepEqual(lines, ["❯ 你好", "  你"]);
  assert.deepEqual([cursorRow, cursorColumn], [1, 4]);
});

test("render lines places cursor after exact width wrap", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "你好a"), { runtimeActive: false });

  const { lines, cursorRow, cursorColumn } = editor.renderLines(7);

  assert.deepEqual(lines, ["❯ 你好a", "  "]);
  assert.deepEqual([cursorRow, cursorColumn], [1, 2]);
});

test("render lines masks secret input", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "pw"), { runtimeActive: false });

  const { lines } = editor.renderLines(20, { mask: true });

  assert.deepEqual(lines, ["❯ **"]);
});

test("history up recalls entries and history down restores the draft", () => {
  const editor = new EditorState();
  editor.apply(inputAction(InputActionKind.Insert, "one"), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.Submit), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.Insert, "two"), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.Submit), { runtimeActive: false });
  editor.apply(inputAction(InputActionKind.Insert, "draft"), { runtimeActive: false });

  editor.apply(inputAction(InputActionKind.HistoryUp), { runtimeActive: false });
  assert.equal(editor.text, "two");
  editor.apply(inputAction(InputActionKind.HistoryUp), { runtimeActive: false });
  assert.equal(editor.text, "one");
  editor.apply(inputAction(InputActionKind.HistoryDown), { runtimeActive: false });
  assert.equal(editor.text, "two");
  editor.apply(inputAction(InputActionKind.HistoryDown), { runtimeActive: false });
  assert.equal(editor.text, "draft");
});
