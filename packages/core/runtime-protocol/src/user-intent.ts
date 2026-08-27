/** User-level input before it is routed to a session action. */

export type UserIntent =
  | {
      readonly type: "prompt";
      readonly text: string;
      readonly source: string;
    }
  | {
      readonly type: "command";
      readonly name: string;
      readonly arguments: readonly string[];
      readonly source: string;
    }
  | {
      readonly type: "steer";
      readonly text: string;
      readonly source: string;
    }
  | {
      readonly type: "follow_up";
      readonly text: string;
      readonly source: string;
    }
  | {
      readonly type: "cancel";
      readonly reason: string;
      readonly source: string;
    }
  | {
      readonly type: "approval";
      readonly text: string;
      readonly source: string;
    }
  | {
      readonly type: "answer";
      readonly text: string;
      readonly source: string;
    }
  | {
      readonly type: "exit";
      readonly source: string;
    };

export type HumanIntentDecision =
  | {
      readonly accepted: true;
      readonly intent: UserIntent;
      readonly reason?: string;
    }
  | {
      readonly accepted: false;
      readonly intent: null;
      readonly reason: string;
    };

export function makePromptIntent(text: string, source: string): UserIntent {
  return { type: "prompt", text, source };
}

export function makeSteerIntent(text: string, source: string): UserIntent {
  return { type: "steer", text, source };
}

export function makeFollowUpIntent(text: string, source: string): UserIntent {
  return { type: "follow_up", text, source };
}

export function makeCancelIntent(reason: string, source: string): UserIntent {
  return { type: "cancel", reason, source };
}

export function makeApprovalIntent(text: string, source: string): UserIntent {
  return { type: "approval", text, source };
}

export function makeAnswerIntent(text: string, source: string): UserIntent {
  return { type: "answer", text, source };
}
