/** Actions accepted by a runtime session after intent routing. */

export interface SessionActionBase {
  readonly id: string;
  readonly source: string;
}

export interface PromptAction extends SessionActionBase {
  readonly type: "prompt";
  readonly text: string;
}

export interface CommandAction extends SessionActionBase {
  readonly type: "command";
  readonly name: string;
  readonly arguments: readonly string[];
}

export interface SteerAction extends SessionActionBase {
  readonly type: "steer";
  readonly text: string;
}

export interface FollowUpAction extends SessionActionBase {
  readonly type: "follow_up";
  readonly text: string;
}

export interface CancelAction extends SessionActionBase {
  readonly type: "cancel";
  readonly reason: string;
}

/** Compatibility shape until approvals have a dedicated runtime path. */
export interface ApprovalAction extends SessionActionBase {
  readonly type: "approval";
  readonly text: string;
}

/** Compatibility shape until answers have a dedicated runtime path. */
export interface AnswerAction extends SessionActionBase {
  readonly type: "answer";
  readonly text: string;
}

export interface ExitAction extends SessionActionBase {
  readonly type: "exit";
}

export type SessionAction =
  | PromptAction
  | CommandAction
  | SteerAction
  | FollowUpAction
  | CancelAction
  | ApprovalAction
  | AnswerAction
  | ExitAction;
