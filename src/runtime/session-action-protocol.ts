import { randomUUID } from "node:crypto";

import type {
  CancelAction,
  CommandAction,
  ExitAction,
  PromptAction,
  SessionAction,
} from "./session-action.ts";

function actionId(): string {
  return `action_${randomUUID()}`;
}

export function makePromptAction(text: string, source: string): PromptAction {
  return { id: actionId(), type: "prompt", text, source };
}

export function makeCommandAction(
  name: string,
  arguments_: readonly string[] = [],
  source = "command",
): CommandAction {
  return {
    id: actionId(),
    type: "command",
    name,
    arguments: [...arguments_],
    source,
  };
}

export function makeCancelAction(
  reason = "cancelled",
  source = "user",
): CancelAction {
  return { id: actionId(), type: "cancel", reason, source };
}

export function makeExitAction(source = "user"): ExitAction {
  return { id: actionId(), type: "exit", source };
}

export function isSessionAction(value: unknown): value is SessionAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const action = value as { id?: unknown; type?: unknown; source?: unknown };
  return (
    typeof action.id === "string" &&
    typeof action.source === "string" &&
    (action.type === "prompt" ||
      action.type === "command" ||
      action.type === "cancel" ||
      action.type === "exit")
  );
}
