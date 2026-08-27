/** Canonical events and the event bus used by the runtime. */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export const EventKind = {
  InputUserMessage: "input.user_message",
  /** Compatibility alias for InputUserMessage. */
  InputReceived: "input.user_message",
  InputSlashCommand: "input.slash_command",
  InputPending: "input.pending",
  InputHeld: "input.held",
  InputCancelRequested: "input.cancel_requested",

  TaskStarted: "task.started",
  TaskStateChanged: "task.state_changed",
  TaskCompleted: "task.completed",
  TaskFailed: "task.failed",
  TaskCancelled: "task.cancelled",

  ModelRequestStarted: "model.request_started",
  ModelTextDelta: "model.text_delta",
  ModelReasoningDelta: "model.reasoning_delta",
  ModelToolCallDelta: "model.tool_call_delta",
  ModelRetryScheduled: "model.retry_scheduled",
  ModelResponseValidating: "model.response_validating",
  ModelResponseCommitted: "model.response_committed",
  ModelResponseAborted: "model.response_aborted",
  ModelRequestFailed: "model.request_failed",
  ModelResponseSummary: "model.response_summary",
  ModelSwitched: "model.switched",

  AgentRepeatWarning: "agent.repeat_warning",

  ToolStarted: "tool.started",
  ToolOutputDelta: "tool.output_delta",
  ToolFinished: "tool.finished",

  SessionReady: "session.ready",
  SessionStopped: "session.stopped",
  UiMessage: "ui.message",
  RoutingDecided: "routing.decided",
  /** Compatibility alias for RoutingDecided. */
  RouteDecided: "routing.decided",
  RoutingRejected: "routing.rejected",
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

const EVENT_KIND_VALUES: ReadonlySet<string> = new Set(
  Object.values(EventKind),
);

export const EventSource = {
  User: "user",
  Cli: "cli",
  Model: "model",
  Tool: "tool",
  Session: "session",
  Router: "router",
  System: "system",
} as const;

export type EventSource = (typeof EventSource)[keyof typeof EventSource];

const EVENT_SOURCE_VALUES: ReadonlySet<string> = new Set(
  Object.values(EventSource),
);

export class EventValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EventValidationError";
  }
}

/**
 * Payload carried by an event. Every payload may gain a projection gap marker
 * when a subscriber mailbox drops or coalesces events under backpressure.
 */
export interface EventPayloadBase {
  _projection_dropped?: number;
  [field: string]: unknown;
}

export interface UserMessagePayload extends EventPayloadBase {
  content: string;
  strategy?: string;
}

export interface SlashCommandPayload extends EventPayloadBase {
  content: string;
}

export interface InputPendingPayload extends EventPayloadBase {
  pending_count: number;
}

export interface InputHeldPayload extends EventPayloadBase {
  held_count: number;
}

export interface TaskStateChangedPayload extends EventPayloadBase {
  state: string;
}

export interface ModelRequestStartedPayload extends EventPayloadBase {
  request_id: string;
}

export interface ModelDeltaPayload extends EventPayloadBase {
  text: string;
  request_id?: string;
  coalesced_from_sequence?: number;
}

export interface ModelToolCallDeltaPayload extends EventPayloadBase {
  index: number;
  request_id?: string;
  coalesced_from_sequence?: number;
}

export interface ModelRetryScheduledPayload extends EventPayloadBase {
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  error_kind: string;
}

export interface AgentRepeatWarningPayload extends EventPayloadBase {
  tool_name: string;
  repeat_count: number;
  content: string;
}

export interface ToolStartedPayload extends EventPayloadBase {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolOutputDeltaPayload extends EventPayloadBase {
  stream: string;
  text: string;
  coalesced_from_sequence?: number;
}

export interface ToolFinishedPayload extends EventPayloadBase {
  status: string;
}

export interface UiMessagePayload extends EventPayloadBase {
  text: string;
  style?: string;
}

export interface RoutingDecidedPayload extends EventPayloadBase {
  destination: string;
  reason: string;
}

export interface RoutingRejectedPayload extends EventPayloadBase {
  reason: string;
}

export interface EventPayloadMap {
  "input.user_message": UserMessagePayload;
  "input.slash_command": SlashCommandPayload;
  "input.pending": InputPendingPayload;
  "input.held": InputHeldPayload;
  "input.cancel_requested": EventPayloadBase;
  "task.started": EventPayloadBase;
  "task.state_changed": TaskStateChangedPayload;
  "task.completed": EventPayloadBase;
  "task.failed": EventPayloadBase;
  "task.cancelled": EventPayloadBase;
  "model.request_started": ModelRequestStartedPayload;
  "model.text_delta": ModelDeltaPayload;
  "model.reasoning_delta": ModelDeltaPayload;
  "model.tool_call_delta": ModelToolCallDeltaPayload;
  "model.retry_scheduled": ModelRetryScheduledPayload;
  "model.response_validating": EventPayloadBase;
  "model.response_committed": EventPayloadBase;
  "model.response_aborted": EventPayloadBase;
  "model.request_failed": EventPayloadBase;
  "model.response_summary": EventPayloadBase;
  "model.switched": EventPayloadBase;
  "agent.repeat_warning": AgentRepeatWarningPayload;
  "tool.started": ToolStartedPayload;
  "tool.output_delta": ToolOutputDeltaPayload;
  "tool.finished": ToolFinishedPayload;
  "session.ready": EventPayloadBase;
  "session.stopped": EventPayloadBase;
  "ui.message": UiMessagePayload;
  "routing.decided": RoutingDecidedPayload;
  "routing.rejected": RoutingRejectedPayload;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [P in keyof T]: DeepReadonly<T[P]> }
      : T;

/**
 * Immutable transport envelope.
 *
 * ``sequence`` is zero before publication. {@link EventBus} replaces it with
 * a strictly increasing session-wide sequence while retaining ``event_id``.
 */
export interface EventEnvelope<K extends EventKind = EventKind> {
  readonly event_id: string;
  readonly kind: K;
  readonly source: EventSource;
  readonly session_id: string;
  readonly task_id: string | null;
  readonly correlation_id: string | null;
  readonly sequence: number;
  readonly payload: DeepReadonly<EventPayloadMap[K]>;
}

/** Discriminated union over all known event kinds. */
export type AnyEventEnvelope = {
  [K in EventKind]: EventEnvelope<K>;
}[EventKind];

/** Deep-copy containers into deeply frozen ones, like Python's ``_freeze``. */
function freezeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeValue(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    if (value instanceof Map || value instanceof Set) {
      return Object.freeze(value);
    }
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = freezeValue(item);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

function gapOf(payload: Record<string, unknown>): number {
  const value = payload["_projection_dropped"];
  return typeof value === "number" && value > 0 ? value : 0;
}

export type PayloadFieldType = "string" | "integer" | "object";

export type EventValidator = (event: AnyEventEnvelope) => boolean | void;

export interface EventSpecOptions {
  kind: EventKind;
  sources?: ReadonlySet<EventSource> | null;
  required_payload?: ReadonlySet<string>;
  payload_types?: Readonly<Record<string, PayloadFieldType>>;
  require_task_id?: boolean;
  require_correlation_id?: boolean;
  max_payload_chars?: number;
  validator?: EventValidator | null;
}

const DEFAULT_MAX_PAYLOAD_CHARS = 1_000_000;

function payloadFieldMatches(value: unknown, expected: PayloadFieldType) {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}

/** Validation rules for a single event kind. */
export class EventSpec {
  readonly kind: EventKind;
  readonly sources: ReadonlySet<EventSource> | null;
  readonly required_payload: ReadonlySet<string>;
  readonly payload_types: Readonly<Record<string, PayloadFieldType>>;
  readonly require_task_id: boolean;
  readonly require_correlation_id: boolean;
  readonly max_payload_chars: number;
  readonly validator: EventValidator | null;

  constructor(options: EventSpecOptions) {
    this.kind = options.kind;
    this.sources = options.sources ?? null;
    this.required_payload = options.required_payload ?? new Set();
    this.payload_types = options.payload_types ?? {};
    this.require_task_id = options.require_task_id ?? false;
    this.require_correlation_id = options.require_correlation_id ?? false;
    this.max_payload_chars =
      options.max_payload_chars ?? DEFAULT_MAX_PAYLOAD_CHARS;
    this.validator = options.validator ?? null;
  }

  validate(event: AnyEventEnvelope): void {
    if (event.kind !== this.kind) {
      throw new EventValidationError(
        `expected event kind ${this.kind}, got ${event.kind}`,
      );
    }
    if (this.sources !== null && !this.sources.has(event.source)) {
      throw new EventValidationError(
        `source ${event.source} is not valid for ${event.kind}`,
      );
    }
    if (this.require_task_id && !event.task_id) {
      throw new EventValidationError(`event ${event.kind} requires task_id`);
    }
    if (this.require_correlation_id && !event.correlation_id) {
      throw new EventValidationError(
        `event ${event.kind} requires correlation_id`,
      );
    }
    const payload = event.payload as Record<string, unknown>;
    const missing = [...this.required_payload]
      .filter((name) => !(name in payload))
      .sort();
    if (missing.length > 0) {
      throw new EventValidationError(
        `event ${event.kind} is missing payload fields: ${missing.join(", ")}`,
      );
    }
    for (const [name, expected] of Object.entries(this.payload_types)) {
      if (name in payload && !payloadFieldMatches(payload[name], expected)) {
        throw new EventValidationError(
          `event ${event.kind} payload field '${name}' has invalid type`,
        );
      }
    }
    let payloadSize: number;
    try {
      payloadSize = JSON.stringify(payload).length;
    } catch (error) {
      throw new EventValidationError(
        `event ${event.kind} payload must be JSON-compatible`,
        { cause: error },
      );
    }
    if (payloadSize > this.max_payload_chars) {
      throw new EventValidationError(
        `event ${event.kind} payload exceeds ${this.max_payload_chars} characters`,
      );
    }
    if (this.validator !== null && this.validator(event) === false) {
      throw new EventValidationError(
        `custom validation failed for ${event.kind}`,
      );
    }
  }
}

interface SpecInit {
  sources: EventSource[];
  required_payload?: string[];
  payload_types?: Record<string, PayloadFieldType>;
  require_task_id?: boolean;
  require_correlation_id?: boolean;
  max_payload_chars?: number;
}

function spec(kind: EventKind, init: SpecInit): EventSpec {
  return new EventSpec({
    kind,
    sources: new Set(init.sources),
    required_payload: new Set(init.required_payload),
    payload_types: init.payload_types,
    require_task_id: init.require_task_id,
    require_correlation_id: init.require_correlation_id,
    max_payload_chars: init.max_payload_chars,
  });
}

function taskLifecycleSpec(kind: EventKind): EventSpec {
  return spec(kind, { sources: [EventSource.Session], require_task_id: true });
}

function modelEventSpec(kind: EventKind, delta: boolean): EventSpec {
  return spec(kind, {
    sources: [EventSource.Model],
    require_task_id: true,
    require_correlation_id: true,
    max_payload_chars: delta ? 16_384 : 100_000,
  });
}

function toolEventSpec(kind: EventKind): EventSpec {
  return spec(kind, {
    sources: [EventSource.Tool],
    require_task_id: true,
    require_correlation_id: true,
    max_payload_chars: 100_000,
  });
}

// The default boundary prevents external/user events from impersonating model,
// tool, router, and lifecycle callbacks. Integrations may add stricter payload
// specs through EventFactory.register without changing the envelope protocol.
export const EVENT_SPECS: ReadonlyMap<EventKind, EventSpec> = new Map(
  [
    spec(EventKind.InputUserMessage, {
      sources: [EventSource.User, EventSource.Cli],
      required_payload: ["content"],
      payload_types: { content: "string", strategy: "string" },
      max_payload_chars: 100_000,
    }),
    spec(EventKind.InputSlashCommand, {
      sources: [EventSource.User, EventSource.Cli],
      required_payload: ["content"],
      payload_types: { content: "string" },
      max_payload_chars: 16_384,
    }),
    spec(EventKind.InputPending, {
      sources: [EventSource.Session],
      required_payload: ["pending_count"],
      payload_types: { pending_count: "integer" },
      require_task_id: true,
      require_correlation_id: true,
    }),
    spec(EventKind.InputHeld, {
      sources: [EventSource.Session],
      required_payload: ["held_count"],
      payload_types: { held_count: "integer" },
      require_task_id: true,
      require_correlation_id: true,
    }),
    spec(EventKind.InputCancelRequested, {
      sources: [EventSource.User, EventSource.Cli, EventSource.Session],
    }),
    taskLifecycleSpec(EventKind.TaskStarted),
    spec(EventKind.TaskStateChanged, {
      sources: [EventSource.Session],
      required_payload: ["state"],
      payload_types: { state: "string" },
      require_task_id: true,
    }),
    taskLifecycleSpec(EventKind.TaskCompleted),
    taskLifecycleSpec(EventKind.TaskFailed),
    taskLifecycleSpec(EventKind.TaskCancelled),
    spec(EventKind.SessionReady, { sources: [EventSource.Session] }),
    spec(EventKind.SessionStopped, { sources: [EventSource.Session] }),
    spec(EventKind.ModelRequestStarted, {
      sources: [EventSource.Model],
      required_payload: ["request_id"],
      payload_types: { request_id: "string" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 100_000,
    }),
    spec(EventKind.ModelTextDelta, {
      sources: [EventSource.Model],
      required_payload: ["text"],
      payload_types: { text: "string", request_id: "string" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 16_384,
    }),
    spec(EventKind.ModelReasoningDelta, {
      sources: [EventSource.Model],
      required_payload: ["text"],
      payload_types: { text: "string", request_id: "string" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 16_384,
    }),
    spec(EventKind.ModelToolCallDelta, {
      sources: [EventSource.Model],
      required_payload: ["index"],
      payload_types: { index: "integer", request_id: "string" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 16_384,
    }),
    spec(EventKind.ModelRetryScheduled, {
      sources: [EventSource.Model],
      required_payload: ["attempt", "max_attempts", "delay_ms", "error_kind"],
      payload_types: {
        attempt: "integer",
        max_attempts: "integer",
        delay_ms: "integer",
        error_kind: "string",
      },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 16_384,
    }),
    modelEventSpec(EventKind.ModelResponseValidating, false),
    modelEventSpec(EventKind.ModelResponseCommitted, false),
    modelEventSpec(EventKind.ModelResponseAborted, false),
    modelEventSpec(EventKind.ModelRequestFailed, false),
    modelEventSpec(EventKind.ModelResponseSummary, false),
    spec(EventKind.ModelSwitched, {
      sources: [EventSource.Model, EventSource.Session, EventSource.System],
    }),
    spec(EventKind.AgentRepeatWarning, {
      sources: [EventSource.System],
      required_payload: ["tool_name", "repeat_count", "content"],
      payload_types: {
        tool_name: "string",
        repeat_count: "integer",
        content: "string",
      },
      require_task_id: true,
      max_payload_chars: 100_000,
    }),
    spec(EventKind.UiMessage, {
      sources: [EventSource.Cli, EventSource.Session, EventSource.System],
      required_payload: ["text"],
      payload_types: { text: "string", style: "string" },
      max_payload_chars: 100_000,
    }),
    spec(EventKind.ToolStarted, {
      sources: [EventSource.Tool],
      required_payload: ["name", "arguments"],
      payload_types: { name: "string", arguments: "object" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 100_000,
    }),
    spec(EventKind.ToolOutputDelta, {
      sources: [EventSource.Tool],
      required_payload: ["stream", "text"],
      payload_types: { stream: "string", text: "string" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 16_384,
    }),
    spec(EventKind.ToolFinished, {
      sources: [EventSource.Tool],
      required_payload: ["status"],
      payload_types: { status: "string" },
      require_task_id: true,
      require_correlation_id: true,
      max_payload_chars: 100_000,
    }),
    spec(EventKind.RoutingDecided, {
      sources: [EventSource.Router],
      required_payload: ["destination", "reason"],
      payload_types: { destination: "string", reason: "string" },
      require_correlation_id: true,
    }),
    spec(EventKind.RoutingRejected, {
      sources: [EventSource.Router],
      required_payload: ["reason"],
      payload_types: { reason: "string" },
      require_correlation_id: true,
    }),
  ].map((eventSpec) => [eventSpec.kind, eventSpec]),
);

export interface CreateEventOptions<K extends EventKind> {
  source: EventSource | string;
  session_id: string;
  task_id?: string | null;
  correlation_id?: string | null;
  sequence?: number;
  payload?: EventPayloadMap[K];
  event_id?: string;
}

/** Create validated envelopes without assigning publication order. */
export class EventFactory {
  private readonly specs: Map<EventKind, EventSpec>;

  constructor(specs?: ReadonlyMap<EventKind, EventSpec>) {
    this.specs = new Map(specs ?? EVENT_SPECS);
  }

  register(eventSpec: EventSpec): void {
    this.specs.set(eventSpec.kind, eventSpec);
  }

  create<K extends EventKind>(
    kind: K | string,
    options: CreateEventOptions<K>,
  ): EventEnvelope<K> {
    if (!EVENT_KIND_VALUES.has(kind) && !this.specs.has(kind as K)) {
      throw new EventValidationError(
        `'${String(kind)}' is not a valid EventKind`,
      );
    }
    if (!EVENT_SOURCE_VALUES.has(options.source)) {
      throw new EventValidationError(
        `'${String(options.source)}' is not a valid EventSource`,
      );
    }
    const eventKind = kind as K;
    const eventSource = options.source as EventSource;
    const eventId = options.event_id ?? randomUUID().replaceAll("-", "");
    const sessionId = options.session_id;
    const sequence = options.sequence ?? 0;
    if (!eventId) {
      throw new EventValidationError("event_id must not be empty");
    }
    if (!sessionId) {
      throw new EventValidationError("session_id must not be empty");
    }
    if (sequence < 0) {
      throw new EventValidationError("sequence must be non-negative");
    }
    const envelope: EventEnvelope<K> = {
      event_id: eventId,
      kind: eventKind,
      source: eventSource,
      session_id: sessionId,
      task_id: options.task_id ?? null,
      correlation_id: options.correlation_id ?? null,
      sequence,
      payload: freezeValue(options.payload ?? {}) as DeepReadonly<
        EventPayloadMap[K]
      >,
    };
    const eventSpec = this.specs.get(eventKind);
    if (eventSpec !== undefined) {
      eventSpec.validate(envelope as AnyEventEnvelope);
    }
    return envelope;
  }

  validate(event: AnyEventEnvelope): void {
    const eventSpec = this.specs.get(event.kind);
    if (eventSpec !== undefined) {
      eventSpec.validate(event);
    }
  }
}

const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  "api_key",
  "apikey",
  "authorization",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
]);

const SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /(authorization\s*:\s*bearer\s+)[^\s'"]+/gi,
  /(\b(?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*)[^\s'"]+/gi,
];

function projectValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => projectValue(item));
  }
  if (value !== null && typeof value === "object") {
    const projected: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll("-", "_");
      if (SENSITIVE_FIELDS.has(normalized) || normalized.endsWith("_secret")) {
        projected[key] = "[REDACTED]";
      } else {
        projected[key] = projectValue(item);
      }
    }
    return projected;
  }
  if (typeof value === "string") {
    let projected = value;
    for (const pattern of SENSITIVE_TEXT_PATTERNS) {
      projected = projected.replace(pattern, "$1[REDACTED]");
    }
    return projected;
  }
  return value;
}

export interface ProjectedEvent {
  event_id: string;
  kind: EventKind;
  source: EventSource;
  session_id: string;
  task_id: string | null;
  correlation_id: string | null;
  sequence: number;
  payload: unknown;
}

/** Produce JSON-friendly, recursively redacted audience projections. */
export class EventProjector {
  static readonly AUDIENCES: ReadonlySet<string> = new Set([
    "terminal",
    "log",
    "router",
  ]);

  project(
    event: AnyEventEnvelope,
    audience: string = "terminal",
  ): ProjectedEvent {
    if (!EventProjector.AUDIENCES.has(audience)) {
      throw new Error(`unknown event audience: ${audience}`);
    }
    return {
      event_id: event.event_id,
      kind: event.kind,
      source: event.source,
      session_id: event.session_id,
      task_id: event.task_id,
      correlation_id: event.correlation_id,
      sequence: event.sequence,
      payload: projectValue(event.payload),
    };
  }
}

const COALESCIBLE_EVENTS: ReadonlySet<EventKind> = new Set([
  EventKind.ModelTextDelta,
  EventKind.ModelReasoningDelta,
  EventKind.ModelToolCallDelta,
  EventKind.ToolOutputDelta,
]);
const MAX_COALESCED_TEXT_CHARS = 65_536;
// Reserved headroom so control/lifecycle events always fit in a mailbox even
// when display-only deltas flood it.
const MAILBOX_CRITICAL_HEADROOM = 64;

function withPayload(
  event: AnyEventEnvelope,
  payload: Record<string, unknown>,
): AnyEventEnvelope {
  return {
    ...event,
    payload: freezeValue(payload) as AnyEventEnvelope["payload"],
  } as AnyEventEnvelope;
}

export type SubscriberCallback = (
  event: AnyEventEnvelope,
) => void | Promise<void>;

/**
 * One bounded queue per subscriber, drained by a promise loop.
 *
 * A slow terminal projection can no longer stall another subscriber.
 * Under pressure only adjacent compatible deltas are combined; lifecycle and
 * control events are never discarded.
 */
/**
 * Identifies the mailbox whose callback is currently executing, the
 * single-threaded analogue of Python's ``self._worker is current_thread()``
 * self-join guard in ``_SubscriberMailbox.close``.
 */
const subscriberCallbackContext = new AsyncLocalStorage<SubscriberMailbox>();

class SubscriberMailbox {
  private readonly callback: SubscriberCallback;
  readonly maxItems: number;
  private items: AnyEventEnvelope[] = [];
  private unfinished = 0;
  private dropped = 0;
  private pendingGap = 0;
  private closed = false;
  private wakeWaiters: Array<() => void> = [];
  private flushWaiters: Array<() => void> = [];
  private readonly workerDone: Promise<void>;

  constructor(callback: SubscriberCallback, maxItems: number) {
    this.callback = callback;
    this.maxItems = maxItems;
    this.workerDone = this.run();
  }

  private static merge(
    left: AnyEventEnvelope,
    right: AnyEventEnvelope,
  ): AnyEventEnvelope | null {
    if (
      left.kind !== right.kind ||
      left.task_id !== right.task_id ||
      left.correlation_id !== right.correlation_id ||
      !COALESCIBLE_EVENTS.has(left.kind)
    ) {
      return null;
    }
    const leftText = left.payload["text"];
    const rightText = right.payload["text"];
    if (typeof leftText !== "string" || typeof rightText !== "string") {
      return null;
    }
    if (leftText.length + rightText.length > MAX_COALESCED_TEXT_CHARS) {
      return null;
    }
    const payload: Record<string, unknown> = { ...right.payload };
    payload["text"] = leftText + rightText;
    const inheritedGap = gapOf(left.payload);
    if (inheritedGap > 0) {
      payload["_projection_dropped"] = gapOf(right.payload) + inheritedGap;
    }
    payload["coalesced_from_sequence"] =
      left.payload["coalesced_from_sequence"] ?? left.sequence;
    return withPayload(right, payload);
  }

  enqueue(event: AnyEventEnvelope): boolean {
    if (this.closed) {
      return false;
    }
    if (this.items.length > 0) {
      const last = this.items[this.items.length - 1]!;
      const merged = SubscriberMailbox.merge(last, event);
      if (
        merged !== null &&
        this.items.length >= this.maxItems - MAILBOX_CRITICAL_HEADROOM
      ) {
        this.items[this.items.length - 1] = this.withGapMarker(merged);
        return true;
      }
    }
    if (
      COALESCIBLE_EVENTS.has(event.kind) &&
      this.items.length >= this.maxItems - MAILBOX_CRITICAL_HEADROOM
    ) {
      this.recordDrop();
      return false;
    }
    if (this.items.length >= this.maxItems) {
      // Preserve control/lifecycle events by evicting an older display-only
      // delta. If a subscriber cannot consume even the reserved critical
      // capacity, detach at this projection boundary instead of blocking the
      // runtime and cancellation.
      let droppedIndex = this.items.findIndex((queued) =>
        COALESCIBLE_EVENTS.has(queued.kind),
      );
      if (droppedIndex === -1) {
        droppedIndex = 0;
      }
      const droppedEvent = this.items[droppedIndex]!;
      this.items.splice(droppedIndex, 1);
      this.unfinished -= 1;
      this.recordDrop(1 + gapOf(droppedEvent.payload));
    }
    this.items.push(this.withGapMarker(event));
    this.unfinished += 1;
    this.wake();
    return true;
  }

  private recordDrop(count: number = 1): void {
    this.dropped += count;
    this.pendingGap += count;
  }

  private withGapMarker(event: AnyEventEnvelope): AnyEventEnvelope {
    if (this.pendingGap === 0) {
      return event;
    }
    const payload: Record<string, unknown> = { ...event.payload };
    payload["_projection_dropped"] = gapOf(payload) + this.pendingGap;
    this.pendingGap = 0;
    return withPayload(event, payload);
  }

  async flush(timeoutMs?: number): Promise<boolean> {
    const deadline =
      timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (this.unfinished > 0) {
      if (deadline === undefined) {
        await new Promise<void>((resolve) => {
          this.flushWaiters.push(resolve);
        });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      const waiter = new Promise<void>((resolve) => {
        this.flushWaiters.push(resolve);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      });
      await Promise.race([waiter, timeout]);
      clearTimeout(timer);
    }
    return true;
  }

  async close(): Promise<void> {
    if (subscriberCallbackContext.getStore() === this) {
      // Self-join guard: closing from inside the subscriber callback must
      // not flush or await the worker — the worker is this very call stack,
      // so waiting here would deadlock. Remaining items are still drained
      // by the worker before it exits, as in the Python original.
      this.closed = true;
      this.wake();
      this.notifyFlushWaiters();
      return;
    }
    const drained = await this.flush(2000);
    this.closed = true;
    if (!drained) {
      const queued = this.items.length;
      this.items = [];
      this.unfinished -= queued;
      this.recordDrop(queued);
    }
    this.wake();
    this.notifyFlushWaiters();
    await this.workerDone;
  }

  private wake(): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private notifyFlushWaiters(): void {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async run(): Promise<void> {
    for (;;) {
      while (this.items.length === 0 && !this.closed) {
        await new Promise<void>((resolve) => {
          this.wakeWaiters.push(resolve);
        });
      }
      if (this.items.length === 0 && this.closed) {
        return;
      }
      const event = this.items.shift()!;
      try {
        await subscriberCallbackContext.run(this, () => this.callback(event));
      } catch {
        // A broken projection is isolated to its own mailbox.
      } finally {
        this.unfinished -= 1;
        this.notifyFlushWaiters();
      }
    }
  }
}

export interface EventBusOptions {
  factory?: EventFactory;
  max_buffered_events?: number;
  subscriber_mailbox_size?: number;
}

export class EventBufferEmptyError extends Error {
  constructor() {
    super("no buffered events");
    this.name = "EventBufferEmptyError";
  }
}

export class EventBufferTimeoutError extends Error {
  constructor() {
    super("timed out waiting for a buffered event");
    this.name = "EventBufferTimeoutError";
  }
}

/**
 * Thrown by publish/subscribe and used to reject pending pull waiters once
 * the bus has been closed, so consumers can detect shutdown via `instanceof`
 * instead of matching the message.
 */
export class EventBusClosedError extends Error {
  constructor() {
    super("event bus is closed");
    this.name = "EventBusClosedError";
  }
}

/** A FIFO bus that assigns one strict sequence across all publishers. */
export class EventBus {
  readonly factory: EventFactory;
  private readonly maxBufferedEvents: number;
  private readonly subscriberMailboxSize: number;
  private readonly buffer: AnyEventEnvelope[] = [];
  private readonly bufferWaiters: Array<{
    resolve: (event: AnyEventEnvelope) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly subscribers = new Map<number, SubscriberMailbox>();
  private subscriberId = 0;
  private sequence = 0;
  private closed = false;

  constructor(options: EventBusOptions = {}) {
    const maxBufferedEvents = options.max_buffered_events ?? 4_096;
    if (maxBufferedEvents <= 0) {
      throw new RangeError("max_buffered_events must be positive");
    }
    const subscriberMailboxSize = options.subscriber_mailbox_size ?? 4_096;
    if (subscriberMailboxSize <= MAILBOX_CRITICAL_HEADROOM) {
      throw new RangeError(
        "subscriber_mailbox_size must be greater than 64",
      );
    }
    this.factory = options.factory ?? new EventFactory();
    this.maxBufferedEvents = maxBufferedEvents;
    this.subscriberMailboxSize = subscriberMailboxSize;
  }

  get last_sequence(): number {
    return this.sequence;
  }

  publish<K extends EventKind>(
    kind: K,
    options: Omit<CreateEventOptions<K>, "sequence" | "event_id">,
  ): EventEnvelope<K> {
    const event = this.factory.create(kind, options);
    return this.publishEvent(event);
  }

  publishEvent<K extends EventKind>(event: EventEnvelope<K>): EventEnvelope<K> {
    this.factory.validate(event as AnyEventEnvelope);
    if (this.closed) {
      throw new EventBusClosedError();
    }
    this.sequence += 1;
    const published = { ...event, sequence: this.sequence };
    if (this.buffer.length >= this.maxBufferedEvents) {
      // Subscriber mailboxes retain/coalesce independently. The pull buffer
      // is bounded so an unused diagnostic queue cannot grow forever during
      // long Bash/model streams.
      this.buffer.shift();
    }
    this.buffer.push(published as AnyEventEnvelope);
    this.feedBufferWaiters();
    for (const mailbox of this.subscribers.values()) {
      mailbox.enqueue(published as AnyEventEnvelope);
    }
    return published;
  }

  /** Wait until every published event reached current subscribers. */
  async flush(): Promise<void> {
    for (;;) {
      const before = this.sequence;
      for (const mailbox of [...this.subscribers.values()]) {
        await mailbox.flush();
      }
      if (this.sequence === before) {
        return;
      }
    }
  }

  /** Deliver queued events and stop subscriber workers exactly once. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const mailboxes = [...this.subscribers.values()];
    this.subscribers.clear();
    await Promise.all(mailboxes.map((mailbox) => mailbox.close()));
    for (const waiter of this.bufferWaiters.splice(0)) {
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
      }
      waiter.reject(new EventBusClosedError());
    }
  }

  /**
   * Fan out every future event and return an unsubscribe callback.
   *
   * The returned callback detaches the subscriber immediately and resolves
   * only after the mailbox drained, so once it returns no further events
   * can be delivered to that callback (matching Python's blocking
   * ``unsubscribe``).
   */
  subscribe(callback: SubscriberCallback): () => Promise<void> {
    if (this.closed) {
      throw new EventBusClosedError();
    }
    this.subscriberId += 1;
    const id = this.subscriberId;
    const mailbox = new SubscriberMailbox(
      callback,
      this.subscriberMailboxSize,
    );
    this.subscribers.set(id, mailbox);

    return async () => {
      const removed = this.subscribers.get(id);
      if (removed !== undefined) {
        this.subscribers.delete(id);
        await removed.close();
      }
    };
  }

  /** Pull the next buffered event, waiting up to ``timeoutMs`` if given. */
  get(timeoutMs?: number): Promise<AnyEventEnvelope> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    if (this.closed) {
      return Promise.reject(new EventBusClosedError());
    }
    return new Promise<AnyEventEnvelope>((resolve, reject) => {
      const waiter: (typeof this.bufferWaiters)[number] = { resolve, reject };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.bufferWaiters.indexOf(waiter);
          if (index !== -1) {
            this.bufferWaiters.splice(index, 1);
          }
          reject(new EventBufferTimeoutError());
        }, timeoutMs);
      }
      this.bufferWaiters.push(waiter);
    });
  }

  getNowait(): AnyEventEnvelope {
    const buffered = this.buffer.shift();
    if (buffered === undefined) {
      throw new EventBufferEmptyError();
    }
    return buffered;
  }

  drain(limit?: number): AnyEventEnvelope[] {
    const events: AnyEventEnvelope[] = [];
    while (limit === undefined || events.length < limit) {
      const buffered = this.buffer.shift();
      if (buffered === undefined) {
        break;
      }
      events.push(buffered);
    }
    return events;
  }

  qsize(): number {
    return this.buffer.length;
  }

  private feedBufferWaiters(): void {
    while (this.bufferWaiters.length > 0 && this.buffer.length > 0) {
      const waiter = this.bufferWaiters.shift()!;
      const event = this.buffer.shift()!;
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(event);
    }
  }
}
