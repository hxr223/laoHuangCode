import type { KeyInput } from "./key-id.ts";
import { keySignature, parseKey } from "./key-parser.ts";

export type ActionId =
  | "toggle_tool_output"
  | "editor_newline"
  | "select_model"
  | "steer_now"
  | "submit_follow_up"
  | "dismiss"
  | "cancel"
  | "toggle_thinking";

export interface Keybinding {
  readonly context: string;
  readonly key: string;
  readonly action: ActionId;
}

export type KeybindingOverrides = Partial<Record<ActionId, readonly string[]>>;

export interface KeybindingConflict {
  readonly context: string;
  readonly key: string;
  readonly actions: readonly ActionId[];
}

interface ResolvedBinding extends Keybinding {
  readonly input: KeyInput;
}

/** Context-aware bindings with deterministic later-binding override semantics. */
export class KeybindingsManager {
  readonly #bindings: readonly ResolvedBinding[];
  readonly #conflicts: readonly KeybindingConflict[];

  constructor(bindings: readonly Keybinding[], overrides: KeybindingOverrides = {}) {
    const disabled = new Set<ActionId>(
      (Object.entries(overrides) as Array<[ActionId, readonly string[] | undefined]>)
        .filter(([, keys]) => keys !== undefined && keys.length === 0)
        .map(([action]) => action),
    );
    const resolved = bindings
      .filter((binding) => !disabled.has(binding.action))
      .map((binding) => ({ ...binding, input: parseKey(binding.key) }));

    for (const [action, keys] of Object.entries(overrides) as Array<
      [ActionId, readonly string[] | undefined]
    >) {
      if (keys === undefined || keys.length === 0) {
        continue;
      }
      const existing = resolved.find((binding) => binding.action === action);
      if (existing === undefined) {
        throw new Error(`cannot override an unbound action: ${action}`);
      }
      for (const key of keys) {
        resolved.push({ ...existing, key, input: parseKey(key) });
      }
    }
    this.#bindings = resolved;
    this.#conflicts = this.#findConflicts(resolved);
  }

  resolve(key: KeyInput, contexts: readonly string[]): ActionId | null {
    const signature = keySignature(key);
    for (const context of contexts) {
      for (let index = this.#bindings.length - 1; index >= 0; index -= 1) {
        const binding = this.#bindings[index]!;
        if (binding.context === context && keySignature(binding.input) === signature) {
          return binding.action;
        }
      }
    }
    return null;
  }

  keysForAction(action: ActionId, contexts: readonly string[]): readonly KeyInput[] {
    return this.#bindings
      .filter((binding) => binding.action === action && contexts.includes(binding.context))
      .map((binding) => binding.input);
  }

  conflicts(): readonly KeybindingConflict[] {
    return this.#conflicts;
  }

  #findConflicts(bindings: readonly ResolvedBinding[]): readonly KeybindingConflict[] {
    const groups = new Map<string, ResolvedBinding[]>();
    for (const binding of bindings) {
      const group = `${binding.context}:${keySignature(binding.input)}`;
      const values = groups.get(group) ?? [];
      values.push(binding);
      groups.set(group, values);
    }
    return [...groups.values()]
      .filter((group) => new Set(group.map((binding) => binding.action)).size > 1)
      .map((group) => ({
        context: group[0]!.context,
        key: group[0]!.key,
        actions: group.map((binding) => binding.action),
      }));
  }
}
