/** Append-only display transcript storage, independent from terminal drawing. */

import type { UIUpdate } from "./state.ts";
import { redactToolText, ToolOutputRedactor } from "./display-policy.ts";
import type {
  HelpCommandViewModel,
  ProviderDetailViewModel,
  ProviderSummaryViewModel,
  QueueStatusViewModel,
} from "./components/views/contracts.ts";

export type RestoredTranscriptItemLike =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string; readonly reasoning?: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly subject: string;
      readonly result: string;
      readonly isError: boolean;
    }
  | { readonly kind: "notice"; readonly text: string; readonly tone: "info" | "warning" | "error" };

interface BaseTranscriptBlock {
  readonly key: string;
  mutable: boolean;
  revision?: number;
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

export interface HelpTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "help";
  readonly commands: readonly HelpCommandViewModel[];
}

export interface ProviderListTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "provider_list";
  readonly providers: readonly ProviderSummaryViewModel[];
}

export interface ProviderDetailTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "provider_detail";
  readonly provider: ProviderDetailViewModel;
}

export interface QueueStatusTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "queue_status";
  readonly queue: QueueStatusViewModel;
}

export type TranscriptBlock =
  | UserTranscriptBlock
  | AssistantTranscriptBlock
  | ThinkingTranscriptBlock
  | ToolTranscriptBlock
  | NoticeTranscriptBlock
  | WelcomeTranscriptBlock
  | HelpTranscriptBlock
  | ProviderListTranscriptBlock
  | ProviderDetailTranscriptBlock
  | QueueStatusTranscriptBlock;

export function createUserBlock(key: string, text: string): UserTranscriptBlock {
  return { kind: "user", key, text, mutable: false, revision: 0 };
}

export function createAssistantBlock(
  key: string,
  text = "",
  mutable = true,
): AssistantTranscriptBlock {
  return { kind: "assistant", key, text, mutable, revision: 0 };
}

export function createThinkingBlock(
  key: string,
  text = "",
  mutable = true,
): ThinkingTranscriptBlock {
  return { kind: "thinking", key, text, mutable, revision: 0 };
}

export function createToolBlock(
  key: string,
  fields: Pick<ToolTranscriptBlock, "name" | "subject" | "status" | "expanded">,
): ToolTranscriptBlock {
  return {
    kind: "tool",
    key,
    mutable: true,
    revision: 0,
    name: redactToolText(fields.name),
    subject: redactToolText(fields.subject),
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
  return { kind: "notice", key, text, tone, mutable: false, revision: 0 };
}

export function createWelcomeBlock(
  title: string,
  details: readonly string[],
): WelcomeTranscriptBlock {
  return { kind: "welcome", key: "welcome", title, details, mutable: false, revision: 0 };
}

export function createHelpBlock(
  key: string,
  commands: readonly HelpCommandViewModel[],
): HelpTranscriptBlock {
  return { kind: "help", key, commands, mutable: false, revision: 0 };
}

export function createProviderListBlock(
  key: string,
  providers: readonly ProviderSummaryViewModel[],
): ProviderListTranscriptBlock {
  return { kind: "provider_list", key, providers, mutable: false, revision: 0 };
}

export function createProviderDetailBlock(
  key: string,
  provider: ProviderDetailViewModel,
): ProviderDetailTranscriptBlock {
  return { kind: "provider_detail", key, provider, mutable: false, revision: 0 };
}

export function createQueueStatusBlock(
  key: string,
  queue: QueueStatusViewModel,
): QueueStatusTranscriptBlock {
  return { kind: "queue_status", key, queue, mutable: false, revision: 0 };
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

function touchBlock(block: BaseTranscriptBlock): void {
  block.revision = (block.revision ?? 0) + 1;
}

/** Holds mutable active blocks and freezes them as their lifecycle completes. */
export class TranscriptStore {
  readonly #blocks: TranscriptBlock[] = [];
  readonly #byCorrelation = new Map<string, TranscriptBlock>();
  readonly #errorStyle: string;
  readonly #toolBufferLimit: number;
  readonly #toolOutputRedactor = new ToolOutputRedactor();
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

  replace(items: readonly RestoredTranscriptItemLike[]): void {
    this.#blocks.splice(0);
    this.#byCorrelation.clear();
    this.#nextBlockId = 0;
    for (const item of items) {
      if (item.kind === "user") {
        this.append(createUserBlock(this.newBlockId(), item.text));
      } else if (item.kind === "assistant") {
        if (item.reasoning !== undefined && item.reasoning !== "") {
          this.append(createThinkingBlock(this.newBlockId(), item.reasoning, false));
        }
        this.append(createAssistantBlock(this.newBlockId(), item.text, false));
      } else if (item.kind === "tool") {
        const block = createToolBlock(item.callId, {
          name: item.name,
          subject: item.subject,
          status: item.isError ? "failed" : "completed",
          expanded: this.#toolOutputExpanded,
        });
        block.stdout = item.isError ? "" : item.result;
        block.stderr = item.isError ? item.result : "";
        block.mutable = false;
        this.append(block);
      } else {
        this.append(createNoticeBlock(this.newBlockId(), item.text, item.tone));
      }
    }
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
      if (item.mutable) {
        item.text += update.text;
        touchBlock(item);
      }
      return;
    }
    if (kind === "model.reasoning_delta") {
      const item = this.#getOrCreateThinking(correlationId);
      if (item.mutable) {
        item.text += update.text;
        touchBlock(item);
      }
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
          item.stdout = (item.stdout + this.#toolOutputRedactor.redact(
            correlationId,
            "stdout",
            update.text,
          )).slice(-this.#toolBufferLimit);
          touchBlock(item);
        } else if (update.stream === "stderr") {
          item.stderr = (item.stderr + this.#toolOutputRedactor.redact(
            correlationId,
            "stderr",
            update.text,
          )).slice(-this.#toolBufferLimit);
          touchBlock(item);
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
      touchBlock(item);
      this.#toolOutputRedactor.clear(correlationId);
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
      if (block.kind === "tool" && block.expanded !== expanded) {
        block.expanded = expanded;
        touchBlock(block);
      }
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
