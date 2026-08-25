/** Convert user-facing intents into the session action protocol. */

import type { UserIntent } from "./user-intent.ts";
import type { SessionAction } from "./session-action.ts";
import {
  makeAnswerAction,
  makeApprovalAction,
  makeCancelAction,
  makeCommandAction,
  makeExitAction,
  makePromptAction,
  makeSteerAction,
  makeFollowUpAction,
} from "./session-action-protocol.ts";

/**
 * Split a user-entered slash command using the same POSIX-like quoting rules
 * as the command dispatcher without importing the CLI command module.
 */
export function splitHumanCommand(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (
        char === "\\" &&
        index + 1 < text.length &&
        ['"', "\\", "$", "`"].includes(text[index + 1]!)
      ) {
        index += 1;
        current += text[index]!;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\\") {
      if (index + 1 < text.length) {
        index += 1;
        current += text[index]!;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
    }
  }
  if (quote !== null) {
    throw new Error("No closing quotation");
  }
  if (started || current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function commandAction(text: string, source: string): SessionAction {
  const [name, ...arguments_] = splitHumanCommand(text);
  if (name === undefined) {
    return makePromptAction(text, source);
  }
  if (name === "/exit" && arguments_.length === 0) {
    return makeExitAction(source);
  }
  return makeCommandAction(name, arguments_, source, text);
}

export function routeHumanIntent(
  intent: UserIntent,
  state: string,
): SessionAction {
  switch (intent.type) {
    case "prompt":
      if (intent.text.startsWith("/")) {
        return commandAction(intent.text, intent.source);
      }
      void state;
      return makePromptAction(intent.text, intent.source);
    case "command":
      return makeCommandAction(intent.name, intent.arguments, intent.source);
    case "steer":
      return makeSteerAction(intent.text, intent.source);
    case "follow_up":
      return makeFollowUpAction(intent.text, intent.source);
    case "cancel":
      return makeCancelAction(intent.reason, intent.source);
    case "approval":
      return makeApprovalAction(intent.text, intent.source);
    case "answer":
      return makeAnswerAction(intent.text, intent.source);
    case "exit":
      return makeExitAction(intent.source);
  }
}
