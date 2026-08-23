import { formatKey } from "./key-parser.ts";
import type { ActionId, KeybindingsManager } from "./keybindings.ts";

/** Return the first active key binding for an action, suitable for compact UI hints. */
export function hintForAction(
  keybindings: KeybindingsManager,
  action: ActionId,
  contexts: readonly string[],
): string | null {
  const key = keybindings.keysForAction(action, contexts)[0];
  return key === undefined ? null : formatKey(key);
}
