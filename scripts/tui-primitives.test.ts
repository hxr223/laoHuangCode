import assert from "node:assert/strict";
import test from "node:test";

import { Box } from "../packages/terminal/tui/src/tui/components/primitives/box.ts";
import { SearchInput } from "../packages/terminal/tui/src/tui/components/primitives/search-input.ts";
import { SelectList } from "../packages/terminal/tui/src/tui/components/primitives/select-list.ts";
import { Text } from "../packages/terminal/tui/src/tui/components/primitives/text.ts";
import { VStack } from "../packages/terminal/tui/src/tui/components/primitives/v-stack.ts";
import { makeKeyInput, type KeyId, type TuiInputEvent } from "../packages/terminal/tui/src/keybindings/key-id.ts";
import { lineText, span } from "../packages/terminal/tui/src/tui/render-model.ts";
import { PI_DARK } from "../packages/terminal/tui/src/tui/theme.ts";

function keyEvent(id: KeyId): TuiInputEvent {
  return { type: "key", key: makeKeyInput(id) };
}

test("text wraps CJK by terminal cells", () => {
  const component = new Text({ text: "中文ab", paddingX: 0, paddingY: 0 });

  const rendered = component.render({ width: 4, theme: PI_DARK });

  assert.deepEqual(rendered.lines.map(lineText), ["中文", "ab"]);
});

test("text applies padding and background through structured spans", () => {
  const component = new Text({
    text: "x",
    paddingX: 1,
    paddingY: 1,
    background: "card",
  });

  const rendered = component.render({ width: 5, theme: PI_DARK });

  assert.deepEqual(rendered.lines.map(lineText), ["     ", " x   ", "     "]);
  assert.equal(rendered.lines[1]?.spans.some((item) => item.style?.foreground !== undefined), false);
  assert.equal(
    rendered.lines[1]?.spans.filter((item) => item.text.includes(" ")).every((item) => item.style?.background === "card"),
    true,
  );
});

test("stack gaps and boxes preserve child content with background padding", () => {
  const stack = new VStack({
    children: [new Text({ text: "one" }), new Text({ text: "two" })],
    gap: 2,
  });
  const box = new Box({ child: stack, paddingX: 1, background: "card" });

  const rendered = box.render({ width: 7, theme: PI_DARK });

  assert.deepEqual(rendered.lines.map(lineText), [" one   ", "       ", "       ", " two   "]);
  assert.deepEqual(rendered.lines[0]?.spans[0], span(" ", { background: "card" }));
  assert.equal(rendered.lines[0]?.spans.at(-1)?.style?.background, "card");
});

test("select list wraps, selects, and cancels", () => {
  const selected: string[] = [];
  let cancelled = false;
  const list = new SelectList({
    items: [
      { value: "a", label: "Alpha", description: "first" },
      { value: "b", label: "Beta", description: "second" },
    ],
    maxVisible: 5,
    onSelect: (item) => selected.push(item.value),
    onCancel: () => { cancelled = true; },
  });
  list.focused = true;

  assert.equal(list.handleInput(keyEvent("up")), true);
  assert.equal(list.selectedItem()?.value, "b");
  list.handleInput(keyEvent("enter"));
  list.handleInput(keyEvent("escape"));

  assert.deepEqual(selected, ["b"]);
  assert.equal(cancelled, true);
});

test("select list hides descriptions before labels at narrow widths", () => {
  const list = new SelectList({
    items: [{ value: "a", label: "Alpha", description: "first detail" }],
  });

  const rendered = list.render({ width: 10, theme: PI_DARK });

  assert.equal(lineText(rendered.lines[0]!), "→ Alpha");
  assert.equal(lineText(rendered.lines[0]!).includes("first detail"), false);
});

test("select list centers a seven item selection and shows its position", () => {
  const list = new SelectList({
    items: Array.from({ length: 7 }, (_, index) => ({
      value: String(index + 1),
      label: `Item ${index + 1}`,
    })),
    maxVisible: 3,
  });
  list.setSelectedValue("4");

  const rendered = list.render({ width: 20, theme: PI_DARK });

  assert.deepEqual(rendered.lines.map(lineText), ["  Item 3", "→ Item 4", "  Item 5", "  (4/7)"]);
});

test("search input reports text updates and cursor metadata", () => {
  const values: string[] = [];
  const input = new SearchInput({
    placeholder: "Search",
    onChange: (value) => values.push(value),
  });
  input.focused = true;
  input.handleInput({ type: "text", text: "中a" });
  input.handleInput(keyEvent("left"));

  const rendered = input.render({ width: 10, theme: PI_DARK });

  assert.deepEqual(values, ["中a"]);
  assert.equal(lineText(rendered.lines[0]!), "❯ 中a");
  assert.deepEqual(rendered.cursor, { row: 0, column: 4 });
});

test("search input masks secret values and handles submit and cancellation", () => {
  const submittedLengths: number[] = [];
  let cancelled = false;
  const input = new SearchInput({
    secret: true,
    onSubmit: (value) => submittedLengths.push(value.length),
    onCancel: () => { cancelled = true; },
  });
  input.focused = true;
  input.handleInput({ type: "paste", text: "token" });
  input.handleInput(keyEvent("enter"));
  input.handleInput(keyEvent("escape"));

  assert.deepEqual(submittedLengths, [5]);
  assert.equal(cancelled, true);
  assert.equal(lineText(input.render({ width: 20, theme: PI_DARK }).lines[0]!), "❯ ");
});
