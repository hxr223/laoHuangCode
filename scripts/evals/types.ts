/** Evaluation-only contracts. Never imported by production code. */
export type Category =
  | "回答正确性"
  | "编码任务完成度"
  | "修改准确性"
  | "工具使用"
  | "任务规划与执行"
  | "指令遵循"
  | "错误恢复"
  | "多轮与上下文"
  | "安全与抗注入"
  | "TUI";
export type CheckSpec =
  | { kind: "file-equals" | "file-includes"; path: string; value: string }
  | { kind: "unchanged"; path: string }
  | { kind: "output-includes" | "output-excludes"; value: string }
  | { kind: "output-equals"; value: string }
  | { kind: "module"; path: string; assertions: string }
  | { kind: "tool-used" | "tool-error"; name: string }
  | { kind: "tool-not-used"; name: string }
  | { kind: "tool-count-max"; name: string; count: number }
  | { kind: "tool-order"; names: readonly string[] }
  | { kind: "event"; name: string; match?: Record<string, unknown> }
  | { kind: "no-extra-files"; allowed: readonly string[] }
  | { kind: "no-forbidden-attempt"; pattern: string }
  | { kind: "tui"; name: string };
export interface Scenario {
  id: string;
  category: Category;
  label: string;
  files: Record<string, string>;
  turns: readonly {
    prompt: string;
    before?: "resume" | "compact";
    steer?: string;
  }[];
  checks: readonly CheckSpec[];
  /** Known correct fixture used exclusively by offline oracle self-tests. */
  solution?: Record<string, string>;
  fault?: "model-once" | "edit-once" | "read-once" | "bash-once";
  tui?:
    | "startup"
    | "input"
    | "stream"
    | "tool-wait"
    | "cancel"
    | "settle"
    | "resize"
    | "exit";
  timeoutMs?: number;
}
export interface TraceEvent {
  kind: string;
  time: number;
  payload: Record<string, unknown>;
}
export interface ToolObservation {
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
}
export interface CheckResult {
  name: string;
  pass: boolean;
  reason: string;
}
export interface RunEvidence {
  scenarioId: string;
  runId: string;
  mode: "live" | "offline";
  status:
    | "completed"
    | "error"
    | "timeout"
    | "cancelled"
    | "budget_exceeded"
    | "not_run";
  output: string;
  error?: string;
  durationMs: number;
  modelRequests: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    missingRequests: number;
  };
  events: TraceEvent[];
  tools: ToolObservation[];
  terminal: string[];
  checks: CheckResult[];
  artifacts?: string;
}
export interface RunOptions {
  mode: "live" | "offline";
  canaryValue?: string;
  model?: string;
  timeoutMs?: number;
  maxRequests?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  outputRoot?: string;
}
