/** Append-only display transcript storage, independent from terminal drawing. */

import type { UIUpdate } from "./state.ts";

interface BaseTranscriptBlock {
  readonly key: string;
  mutable: boolean;
}

export type NoticeTone = "info" | "success" | "warning" | "error" | "dim";

export interface UserTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "user";
  text: string;
}

export interface AssistantTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "assistant";
  text: string;
}

export interface ThinkingTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "thinking";
  text: string;
}

export interface ToolTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "tool";
  name: string;
  subject: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  expanded: boolean;
}

export interface NoticeTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "notice";
  text: string;
  tone: NoticeTone;
}

export interface WelcomeTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "welcome";
  title: string;
  details: readonly string[];
}

export type TranscriptBlock =
  | UserTranscriptBlock
  | AssistantTranscriptBlock
  | ThinkingTranscriptBlock
  | ToolTranscriptBlock
  | NoticeTranscriptBlock
  | WelcomeTranscriptBlock;

export function createUserBlock(key: string, text: string): UserTranscriptBlock {
  return { kind: "user", key, text, mutable: false };
}

export function createAssistantBlock(
  key: string,
  text = "",
  mutable = true,
): AssistantTranscriptBlock {
  return { kind: "assistant", key, text, mutable };
}

export function createThinkingBlock(
  key: string,
  text = "",
  mutable = true,
): ThinkingTranscriptBlock {
  return { kind: "thinking", key, text, mutable };
}

export function createToolBlock(
  key: string,
  fields: Pick<ToolTranscriptBlock, "name" | "subject" | "status" | "expanded">,
): ToolTranscriptBlock {
  return {
    kind: "tool",
    key,
    mutable: true,
    name: fields.name,
    subject: fields.subject,
    status: fields.status,
    exitCode: null,
    durationMs: null,
    stdout: "",
    stderr: "",
    expanded: fields.expanded,
  };
}

export function createNoticeBlock(
  key: string,
  text: string,
  tone: NoticeTone = "info",
): NoticeTranscriptBlock {
  return { kind: "notice", key, text, tone, mutable: false };
}

export function createWelcomeBlock(
  title: string,
  details: readonly string[],
): WelcomeTranscriptBlock {
  return { kind: "welcome", key: "welcome", title, details, mutable: false };
}

export interface TranscriptStoreOptions {
  errorStyle?: string;
  toolBufferLimit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function noticeTone(style: unknown): NoticeTone {
  const value = String(style ?? "");
  if (value.includes("red")) return "error";
  if (value.includes("yellow")) return "warning";
  if (value.includes("green")) return "success";
  if (value.includes("dim")) return "dim";
  return "info";
}

/** Holds mutable active blocks and freezes them as their lifecycle completes. */
export class TranscriptStore {
  readonly #blocks: TranscriptBlock[] = [];
  readonly #byCorrelation = new Map<string, TranscriptBlock>();
  readonly #errorStyle: string;
  readonly #toolBufferLimit: number;
  #toolOutputExpanded = false;
  #nextBlockId = 0;

  constructor(options: TranscriptStoreOptions = {}) {
    this.#errorStyle = options.errorStyle ?? "bold red";
    this.#toolBufferLimit = options.toolBufferLimit ?? 20_000;
  }

  blocks(): readonly TranscriptBlock[] {
    return this.#blocks;
  }

  newBlockId(): string {
    this.#nextBlockId += 1;
    return `local-${this.#nextBlockId}`;
  }

  append(block: TranscriptBlock): void {
    this.#blocks.push(block);
    if (block.key) this.#byCorrelation.set(`${block.kind}:${block.key}`, block);
  }

  blockFor(kind: string, key: string): TranscriptBlock {
    const block = this.#byCorrelation.get(`${kind}:${key}`);
    if (block === undefined) throw new Error(`no transcript block for ${kind}:${key}`);
    return block;
  }

  apply(update: UIUpdate): void {
    const { kind, correlationId } = update;
    if (kind === "ui.message") {
      this.append(createNoticeBlock(this.newBlockId(), update.text, noticeTone(update.payload.style)));
      return;
    }
    if (kind === "model.retry_scheduled") {
      this.append(createNoticeBlock(
        this.newBlockId(),
        `Model request retry ${String(update.payload.attempt)}/` +
          `${String(update.payload.max_attempts)} in ` +
          `${String(update.payload.delay_ms)}ms ` +
          `(${String(update.payload.error_kind)}).`,
        "warning",
      ));
      return;
    }
    if (kind === "model.text_delta") {
      this.freezeThinking();
      const item = this.#getOrCreateAssistant(correlationId);
      if (item.mutable) item.text += update.text;
      return;
    }
    if (kind === "model.reasoning_delta") {
      const item = this.#getOrCreateThinking(correlationId);
      if (item.mutable) item.text += update.text;
      return;
    }
    if (["model.response_committed", "model.response_aborted", "model.request_failed"].includes(kind)) {
      for (const blockKind of ["assistant", "thinking"] as const) {
        const block = this.#byCorrelation.get(`${blockKind}:${correlationId}`);
        if (block !== undefined) block.mutable = false;
      }
      return;
    }
    if (kind === "tool.started") {
      this.freezeThinking();
      const args = update.payload.arguments;
      const subject = isRecord(args) ? String(args.command || args.path || "") : "";
      this.append(createToolBlock(correlationId, {
        name: String(update.payload.name ?? "tool"),
        subject,
        status: "running",
        expanded: this.#toolOutputExpanded,
      }));
      return;
    }
    if (kind === "tool.output_delta") {
      const item = this.#byCorrelation.get(`tool:${correlationId}`);
      if (item?.kind === "tool") {
        if (update.stream === "stdout") {
          item.stdout = (item.stdout + update.text).slice(-this.#toolBufferLimit);
        } else if (update.stream === "stderr") {
          item.stderr = (item.stderr + update.text).slice(-this.#toolBufferLimit);
        }
      }
      return;
    }
    if (kind === "tool.finished") {
      const item = this.#getOrCreateTool(correlationId);
      item.status = String(update.payload.status ?? "completed");
      item.exitCode = typeof update.payload.exit_code === "number"
        ? Math.trunc(update.payload.exit_code)
        : null;
      item.durationMs = typeof update.payload.duration_ms === "number"
        ? Math.trunc(update.payload.duration_ms)
        : null;
      item.mutable = false;
      return;
    }
    if (kind === "task.cancelled") {
      this.append(createNoticeBlock(
        this.newBlockId(),
        "任务已取消；已经完成的文件修改不会自动撤销。",
        "warning",
      ));
      return;
    }
    if (kind === "task.failed") {
      this.append(createNoticeBlock(
        this.newBlockId(),
        `Error: ${String(update.payload.error ?? "Task failed")}`,
        noticeTone(this.#errorStyle),
      ));
    }
  }

  freezeThinking(): void {
    for (const block of this.#blocks) {
      if (block.kind === "thinking") block.mutable = false;
    }
  }

  setToolOutputExpanded(expanded: boolean): void {
    this.#toolOutputExpanded = expanded;
    for (const block of this.#blocks) {
      if (block.kind === "tool") block.expanded = expanded;
    }
  }

  toolOutputExpanded(): boolean {
    return this.#toolOutputExpanded;
  }

  #getOrCreateAssistant(key: string): AssistantTranscriptBlock {
    const existing = this.#byCorrelation.get(`assistant:${key}`);
    if (existing?.kind === "assistant") return existing;
    const block = createAssistantBlock(key);
    this.append(block);
    return block;
  }

  #getOrCreateThinking(key: string): ThinkingTranscriptBlock {
    const existing = this.#byCorrelation.get(`thinking:${key}`);
    if (existing?.kind === "thinking") return existing;
    const block = createThinkingBlock(key);
    this.append(block);
    return block;
  }

  #getOrCreateTool(key: string): ToolTranscriptBlock {
    const existing = this.#byCorrelation.get(`tool:${key}`);
    if (existing?.kind === "tool") return existing;
    const block = createToolBlock(key, {
      name: "tool",
      subject: "",
      status: "running",
      expanded: this.#toolOutputExpanded,
    });
    this.append(block);
    return block;
  }
}
