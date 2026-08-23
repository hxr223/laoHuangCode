/** Append-only display transcript storage, independent from terminal drawing. */

import type { UIUpdate } from "../ui-state.ts";

export interface TranscriptBlock {
  kind: string;
  key: string;
  text: string;
  mutable: boolean;
  name: string;
  subject: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  streamError: string;
  style: string;
}

export function createTranscriptBlock(
  kind: string,
  key: string,
  fields: Partial<Omit<TranscriptBlock, "kind" | "key">> = {},
): TranscriptBlock {
  return {
    kind,
    key,
    text: fields.text ?? "",
    mutable: fields.mutable ?? false,
    name: fields.name ?? "",
    subject: fields.subject ?? "",
    status: fields.status ?? "",
    exitCode: fields.exitCode ?? null,
    durationMs: fields.durationMs ?? null,
    streamError: fields.streamError ?? "",
    style: fields.style ?? "",
  };
}

export interface TranscriptStoreOptions {
  errorStyle?: string;
  toolBufferLimit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Holds mutable active blocks and freezes them as their lifecycle completes. */
export class TranscriptStore {
  readonly #blocks: TranscriptBlock[] = [];
  readonly #byCorrelation = new Map<string, TranscriptBlock>();
  readonly #errorStyle: string;
  readonly #toolBufferLimit: number;
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
    if (block.key) {
      this.#byCorrelation.set(`${block.kind}:${block.key}`, block);
    }
  }

  blockFor(kind: string, key: string): TranscriptBlock {
    const block = this.#byCorrelation.get(`${kind}:${key}`);
    if (block === undefined) {
      throw new Error(`no transcript block for ${kind}:${key}`);
    }
    return block;
  }

  apply(update: UIUpdate): void {
    const kind = update.kind;
    const correlationId = update.correlationId;
    if (kind === "ui.message") {
      this.append(createTranscriptBlock("notice", this.newBlockId(), {
        text: update.text,
        style: String(update.payload.style ?? ""),
      }));
      return;
    }
    if (kind === "model.text_delta") {
      this.freezeThinking();
      const item = this.#getOrCreate("assistant", correlationId, { mutable: true });
      if (item.mutable) {
        item.text += update.text;
      }
      return;
    }
    if (kind === "model.reasoning_delta") {
      const item = this.#getOrCreate("thinking", correlationId, { mutable: true });
      if (item.mutable) {
        item.text += update.text;
      }
      return;
    }
    if (["model.response_committed", "model.response_aborted", "model.request_failed"].includes(kind)) {
      for (const blockKind of ["assistant", "thinking"]) {
        const block = this.#byCorrelation.get(`${blockKind}:${correlationId}`);
        if (block !== undefined) {
          block.mutable = false;
        }
      }
      return;
    }
    if (kind === "tool.started") {
      this.freezeThinking();
      const args = update.payload.arguments;
      const subject = isRecord(args) ? String(args.command || args.path || "") : "";
      this.append(createTranscriptBlock("tool", correlationId, {
        mutable: true,
        name: String(update.payload.name ?? "tool"),
        subject,
        status: "running",
      }));
      return;
    }
    if (kind === "tool.output_delta" && update.stream === "stderr") {
      const item = this.#byCorrelation.get(`tool:${correlationId}`);
      if (item !== undefined) {
        item.streamError = (item.streamError + update.text).slice(-this.#toolBufferLimit);
      }
      return;
    }
    if (kind === "tool.finished") {
      const item = this.#getOrCreate("tool", correlationId);
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
      this.append(createTranscriptBlock("notice", this.newBlockId(), {
        text: "任务已取消；已经完成的文件修改不会自动撤销。",
        style: "yellow",
      }));
      return;
    }
    if (kind === "task.failed") {
      this.append(createTranscriptBlock("notice", this.newBlockId(), {
        text: `Error: ${String(update.payload.error ?? "Task failed")}`,
        style: this.#errorStyle,
      }));
    }
  }

  freezeThinking(): void {
    for (const block of this.#blocks) {
      if (block.kind === "thinking") {
        block.mutable = false;
      }
    }
  }

  #getOrCreate(
    kind: string,
    key: string,
    fields: Partial<Omit<TranscriptBlock, "kind" | "key">> = {},
  ): TranscriptBlock {
    const existing = this.#byCorrelation.get(`${kind}:${key}`);
    if (existing !== undefined) {
      return existing;
    }
    const block = createTranscriptBlock(kind, key, fields);
    this.append(block);
    return block;
  }
}
