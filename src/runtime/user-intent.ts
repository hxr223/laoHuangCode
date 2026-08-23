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
      readonly type: "cancel";
      readonly reason: string;
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
