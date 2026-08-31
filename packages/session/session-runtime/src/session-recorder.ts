import {
  EventKind,
  EventProjector,
  type AnyEventEnvelope,
  type EventBus,
} from "@laohuang/runtime-protocol";
import type {
  NewSessionRecord,
  SessionJournal,
  SessionRecord,
  SessionRecordType,
} from "@laohuang/session-store";

export interface SessionRecorderOptions {
  readonly eventBus: EventBus;
  readonly journal: SessionJournal | (() => SessionJournal | null);
}

/** Mirrors runtime events into append-only session records. */
export class SessionRecorder {
  readonly #journal: SessionJournal | (() => SessionJournal | null);
  readonly #unsubscribe: () => Promise<void>;
  readonly #projector = new EventProjector();

  constructor(options: SessionRecorderOptions) {
    this.#journal = options.journal;
    this.#unsubscribe = options.eventBus.subscribe((event) => {
      this.recordEvent(event);
    });
  }

  recordEvent(event: AnyEventEnvelope): readonly SessionRecord[] {
    const records: SessionRecord[] = [];
    for (const record of this.recordsFor(event)) {
      const journal = this.journal();
      if (journal === null) {
        continue;
      }
      records.push(journal.appendRecord(record));
    }
    return records;
  }

  async close(): Promise<void> {
    await this.#unsubscribe();
  }

  private journal(): SessionJournal | null {
    return typeof this.#journal === "function" ? this.#journal() : this.#journal;
  }

  private recordsFor(event: AnyEventEnvelope): readonly NewSessionRecord[] {
    const payload = this.projectPayload(event);
    const base = {
      taskId: event.task_id ?? undefined,
      turnId: event.correlation_id ?? undefined,
    };
    const record = (recordType: SessionRecordType, extra: Record<string, unknown> = {}): NewSessionRecord => ({
      ...base,
      recordType,
      payload: {
        eventId: event.event_id,
        eventKind: event.kind,
        eventSequence: event.sequence,
        ...payload,
        ...extra,
      },
    });

    switch (event.kind) {
      case EventKind.TaskStarted:
        return [record("turn_started")];
      case EventKind.TaskCompleted:
        return [record("turn_finished", { status: "completed" })];
      case EventKind.TaskFailed:
        return [
          record("error", { status: "failed" }),
          record("turn_finished", { status: "failed" }),
        ];
      case EventKind.TaskCancelled:
        return [
          record("cancelled"),
          record("turn_finished", { status: "cancelled" }),
        ];
      case EventKind.ModelRequestStarted:
        return [record("model_request")];
      case EventKind.ModelResponseCommitted:
      case EventKind.ModelResponseSummary: {
        const usage = payload["usage"];
        return usage === undefined
          ? [record("model_response")]
          : [record("model_response"), record("usage", { usage })];
      }
      case EventKind.ModelRequestFailed:
      case EventKind.ModelResponseAborted:
        return [record("error")];
      case EventKind.ToolStarted:
        return [record("tool_started")];
      case EventKind.ToolFinished:
        return [record("tool_finished")];
      case EventKind.InputPending:
      case EventKind.InputHeld:
        return [record("queue_enqueued")];
      case EventKind.ModelSwitched:
        return [
          record("provider_changed", { provider: payload["provider"] ?? null }),
          record("model_changed", { model: payload["model"] ?? null }),
        ];
      default:
        return [];
    }
  }

  private projectPayload(event: AnyEventEnvelope): Record<string, unknown> {
    const projected = this.#projector.project(event, "log").payload;
    if (projected !== null && typeof projected === "object" && !Array.isArray(projected)) {
      return projected as Record<string, unknown>;
    }
    return { value: projected };
  }
}
