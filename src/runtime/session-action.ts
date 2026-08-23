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

export interface CancelAction extends SessionActionBase {
  readonly type: "cancel";
  readonly reason: string;
}

export interface ExitAction extends SessionActionBase {
  readonly type: "exit";
}

export type SessionAction =
  | PromptAction
  | CommandAction
  | CancelAction
  | ExitAction;
