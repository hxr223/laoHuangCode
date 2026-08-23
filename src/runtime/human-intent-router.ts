/** Convert user-facing intents into the session action protocol. */

import { shlexSplit } from "../commands.ts";
import {
  SessionState,
  type SessionState as SessionStateValue,
} from "../session.ts";
import type { UserIntent } from "./user-intent.ts";
import type { SessionAction } from "./session-action.ts";
import {
  makeAnswerAction,
  makeApprovalAction,
  makeCancelAction,
  makeCommandAction,
  makeExitAction,
  makeFollowUpAction,
  makePromptAction,
  makeSteerAction,
} from "./session-action-protocol.ts";

function commandAction(text: string, source: string): SessionAction {
  const [name, ...arguments_] = shlexSplit(text);
  if (name === undefined) {
    return makePromptAction(text, source);
  }
  return makeCommandAction(name, arguments_, source);
}

export function routeHumanIntent(
  intent: UserIntent,
  state: SessionStateValue,
): SessionAction {
  switch (intent.type) {
    case "prompt":
      if (intent.text.startsWith("/")) {
        return commandAction(intent.text, intent.source);
      }
      return state === SessionState.Idle
        ? makePromptAction(intent.text, intent.source)
        : makeFollowUpAction(intent.text, intent.source);
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
