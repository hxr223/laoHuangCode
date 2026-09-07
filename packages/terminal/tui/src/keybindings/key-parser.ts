import { makeKeyInput, type KeyId, type KeyInput } from "./key-id.ts";

const NAMED_KEYS: Readonly<Record<string, KeyId>> = {
  enter: "enter",
  return: "enter",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  home: "home",
  end: "end",
  page_up: "page_up",
  page_down: "page_down",
};

function controlKeyId(character: string): KeyId {
  if (character === "c") {
    return "ctrl_c";
  }
  if (character === "d") {
    return "ctrl_d";
  }
  if (character === "l") {
    return "ctrl_l";
  }
  if (character === "u") {
    return "ctrl_u";
  }
  return "character";
}

/** Parse a portable binding string such as `ctrl+o` into a normalized key. */
export function parseKey(value: string): KeyInput {
  const parts = value.toLowerCase().split("+").filter(Boolean);
  if (parts.length === 0) {
    throw new Error("key binding cannot be empty");
  }

  let ctrl = false;
  let alt = false;
  let shift = false;
  const base: string[] = [];
  for (const part of parts) {
    if (part === "ctrl" || part === "control") {
      ctrl = true;
    } else if (part === "alt" || part === "option") {
      alt = true;
    } else if (part === "shift") {
      shift = true;
    } else {
      base.push(part);
    }
  }
  if (base.length !== 1) {
    throw new Error(`invalid key binding: ${value}`);
  }

  const name = base[0]!;
  const named = NAMED_KEYS[name];
  if (named !== undefined) {
    return makeKeyInput(named, { ctrl, alt, shift });
  }
  if ([...name].length !== 1) {
    throw new Error(`unknown key binding: ${value}`);
  }
  const id = ctrl ? controlKeyId(name) : "character";
  return makeKeyInput(id, {
    ...(id === "character" ? { text: name } : {}),
    ctrl,
    alt,
    shift,
  });
}

/** Stable lookup key for matching normalized input events. */
export function keySignature(key: KeyInput): string {
  return [key.id, key.text ?? "", key.ctrl, key.alt, key.shift].join(":");
}

/** Human-readable key label used by contextual hints. */
export function formatKey(key: KeyInput): string {
  const modifiers = [key.ctrl ? "Ctrl" : "", key.alt ? "Alt" : "", key.shift ? "Shift" : ""]
    .filter(Boolean);
  const name = key.id === "character"
    ? (key.text ?? "").toUpperCase()
    : key.id === "ctrl_c" ? "C"
    : key.id === "ctrl_d" ? "D"
    : key.id === "ctrl_l" ? "L"
    : key.id === "ctrl_u" ? "U"
    : key.id === "page_up" ? "PageUp"
    : key.id === "page_down" ? "PageDown"
    : key.id[0]!.toUpperCase() + key.id.slice(1);
  return [...modifiers, name].join("+");
}
