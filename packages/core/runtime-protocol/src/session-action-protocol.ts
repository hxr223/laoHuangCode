import { randomUUID } from "node:crypto";

import type {
  AnswerAction,
  ApprovalAction,
  CancelAction,
  CommandAction,
  ExitAction,
  FollowUpAction,
  PromptAction,
  SessionAction,
  SteerAction,
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
  text = [name, ...arguments_].join(" "),
): CommandAction {
  return {
    id: actionId(),
    type: "command",
    name,
    arguments: [...arguments_],
    source,
    text,
  };
}

export function makeSteerAction(text: string, source: string): SteerAction {
  return { id: actionId(), type: "steer", text, source };
}

export function makeFollowUpAction(
  text: string,
  source: string,
): FollowUpAction {
  return { id: actionId(), type: "follow_up", text, source };
}

export function makeCancelAction(
  reason = "cancelled",
  source = "user",
): CancelAction {
  return { id: actionId(), type: "cancel", reason, source };
}

export function makeApprovalAction(
  text: string,
  source: string,
): ApprovalAction {
  return { id: actionId(), type: "approval", text, source };
}

export function makeAnswerAction(text: string, source: string): AnswerAction {
  return { id: actionId(), type: "answer", text, source };
}

export function makeExitAction(source = "user"): ExitAction {
  return { id: actionId(), type: "exit", source };
}

export function isSessionAction(value: unknown): value is SessionAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const action = value as {
    id?: unknown;
    type?: unknown;
    source?: unknown;
    text?: unknown;
    name?: unknown;
    arguments?: unknown;
    reason?: unknown;
  };
  if (typeof action.id !== "string" || typeof action.source !== "string") {
    return false;
  }
  switch (action.type) {
    case "prompt":
    case "steer":
    case "follow_up":
    case "approval":
    case "answer":
      return typeof action.text === "string";
    case "command":
      return (
        typeof action.name === "string" &&
        Array.isArray(action.arguments) &&
        action.arguments.every((item) => typeof item === "string") &&
        (action.text === undefined || typeof action.text === "string")
      );
    case "cancel":
      return typeof action.reason === "string";
    case "exit":
      return true;
    default:
      return false;
  }
}
