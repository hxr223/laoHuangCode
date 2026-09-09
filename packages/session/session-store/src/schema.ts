import type {
  AssistantModelMessage,
  ModelFinishReason,
  SystemModelMessage,
  ToolResultModelMessage,
  UserModelMessage,
  ReasoningEffort,
} from "@laohuang/llm";
import { normalizeSessionTitle } from "./session-metadata.ts";

export type SessionOrigin = "new" | "fork" | "clone" | "import";

export interface SessionHeader {
  readonly schemaVersion: 1;
  readonly type: "session_header";
  readonly sessionId: string;
  readonly createdAt: string;
  readonly initialCwd: string;
  readonly projectRoot: string;
  readonly projectKey: string;
  readonly appVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly origin: SessionOrigin;
  readonly parentSessionId?: string;
  readonly forkedFrom?: {
    readonly sessionId: string;
    readonly seq?: number;
    readonly entryId?: string;
    readonly mode: "before" | "at" | "clone";
  };
}

export interface InstructionFileRecord {
  readonly path: string;
  readonly digest: string;
  readonly scope: string;
}

export interface SessionItemBase {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly seq: number;
  readonly id: string;
  readonly timestamp: string;
  readonly kind: "entry" | "record";
  readonly taskId?: string;
  readonly turnId?: string;
  readonly copiedFrom?: {
    readonly sessionId: string;
    readonly itemId: string;
    readonly seq: number;
  };
}

export interface SystemContextPayload {
  readonly message: SystemModelMessage;
  readonly cwd: string;
  readonly supersedesEntryId?: string;
}

export interface ProjectInstructionsPayload {
  readonly message: UserModelMessage;
  readonly files: readonly InstructionFileRecord[];
  readonly supersedesEntryIds: readonly string[];
}

export interface UserMessagePayload {
  readonly message: UserModelMessage;
  readonly inputEventIds: readonly string[];
  readonly source: "direct" | "pending" | "fork_editor";
}

export interface AssistantMessagePayload {
  readonly message: AssistantModelMessage;
  readonly requestId: string;
  readonly finishReason: ModelFinishReason;
}

export interface ToolResultPayload {
  readonly message: ToolResultModelMessage;
  readonly requestId: string;
  readonly recovered: boolean;
}

export interface ReminderPayload {
  readonly message: UserModelMessage;
  readonly reason: "repeat_tool" | "runtime";
}

export interface CompactionPayload {
  readonly summary: string;
  readonly summarizedFromSeq: number;
  readonly summarizedThroughSeq: number;
  readonly retainedFromSeq: number;
  readonly supersedesCompactionId?: string;
  readonly tokensBefore: number;
  readonly retainedTokens: number;
  readonly summaryInputTokens: number;
  readonly summaryOutputTokens: number;
  readonly provider: string;
  readonly model: string;
  readonly trigger: "automatic" | "manual" | "provider_overflow";
}

export type SessionEntryType =
  | "tool_definitions"
  | "tool_catalog"
  | "system_context"
  | "project_instructions"
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "reminder"
  | "compaction";

export type SessionEntry =
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "tool_definitions";
      readonly payload: { readonly message: SystemModelMessage };
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "tool_catalog";
      readonly payload: { readonly message: UserModelMessage };
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "system_context";
      readonly payload: SystemContextPayload;
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "project_instructions";
      readonly payload: ProjectInstructionsPayload;
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "user_message";
      readonly payload: UserMessagePayload;
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "assistant_message";
      readonly payload: AssistantMessagePayload;
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "tool_result";
      readonly payload: ToolResultPayload;
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "reminder";
      readonly payload: ReminderPayload;
    })
  | (SessionItemBase & {
      readonly kind: "entry";
      readonly entryType: "compaction";
      readonly payload: CompactionPayload;
    });

export type SystemContextEntry = Extract<SessionEntry, { readonly entryType: "system_context" }>;
export type ProjectInstructionsEntry = Extract<SessionEntry, { readonly entryType: "project_instructions" }>;
export type UserMessageEntry = Extract<SessionEntry, { readonly entryType: "user_message" }>;
export type AssistantMessageEntry = Extract<SessionEntry, { readonly entryType: "assistant_message" }>;
export type ToolResultEntry = Extract<SessionEntry, { readonly entryType: "tool_result" }>;
export type ReminderEntry = Extract<SessionEntry, { readonly entryType: "reminder" }>;
export type CompactionEntry = Extract<SessionEntry, { readonly entryType: "compaction" }>;

export type SessionRecordType =
  | "turn_started"
  | "turn_finished"
  | "model_request"
  | "model_response"
  | "tool_started"
  | "tool_finished"
  | "provider_changed"
  | "model_changed"
  | "reasoning_effort_changed"
  | "cwd_changed"
  | "usage"
  | "error"
  | "cancelled"
  | "queue_enqueued"
  | "queue_started"
  | "queue_finished"
  | "compaction_started"
  | "compaction_finished"
  | "session_name_changed"
  | "session_closed";

export interface SessionRecord extends SessionItemBase {
  readonly kind: "record";
  readonly recordType: SessionRecordType;
  readonly payload: Record<string, unknown>;
}

export type SessionItem = SessionEntry | SessionRecord;

export type NewSessionEntry = Omit<SessionEntry, keyof SessionItemBase> & {
  readonly taskId?: string;
  readonly turnId?: string;
  readonly copiedFrom?: SessionItemBase["copiedFrom"];
};

export interface NewSessionRecord {
  readonly recordType: SessionRecordType;
  readonly payload?: Record<string, unknown>;
  readonly taskId?: string;
  readonly turnId?: string;
}

const ENTRY_TYPES: ReadonlySet<string> = new Set([
  "tool_definitions",
  "tool_catalog",
  "system_context",
  "project_instructions",
  "user_message",
  "assistant_message",
  "tool_result",
  "reminder",
  "compaction",
]);

const RECORD_TYPES: ReadonlySet<string> = new Set([
  "turn_started",
  "turn_finished",
  "model_request",
  "model_response",
  "tool_started",
  "tool_finished",
  "provider_changed",
  "model_changed",
  "reasoning_effort_changed",
  "cwd_changed",
  "usage",
  "error",
  "cancelled",
  "queue_enqueued",
  "queue_started",
  "queue_finished",
  "compaction_started",
  "compaction_finished",
  "session_name_changed",
  "session_closed",
]);

const ORIGINS: ReadonlySet<string> = new Set(["new", "fork", "clone", "import"]);
const REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export class SessionSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSchemaError";
  }
}

export function parseSessionHeader(value: unknown): SessionHeader {
  const input = objectOf(value, "session header");
  if (input["schemaVersion"] !== 1) {
    throw new SessionSchemaError("unsupported session schema version");
  }
  if (input["type"] !== "session_header") {
    throw new SessionSchemaError("invalid session header type");
  }
  requireString(input, "sessionId");
  requireString(input, "createdAt");
  requireString(input, "initialCwd");
  requireString(input, "projectRoot");
  requireString(input, "projectKey");
  requireString(input, "appVersion");
  requireString(input, "provider");
  requireString(input, "model");
  if (!REASONING_EFFORTS.has(stringValue(input, "reasoningEffort"))) {
    throw new SessionSchemaError("invalid reasoning effort");
  }
  if (!ORIGINS.has(stringValue(input, "origin"))) {
    throw new SessionSchemaError("invalid session origin");
  }
  if (input["parentSessionId"] !== undefined) {
    requireString(input, "parentSessionId");
  }
  if (input["forkedFrom"] !== undefined) {
    const forkedFrom = objectOf(input["forkedFrom"], "forkedFrom");
    requireString(forkedFrom, "sessionId");
    if (forkedFrom["seq"] !== undefined) {
      requirePositiveInteger(forkedFrom, "seq");
    }
    if (forkedFrom["entryId"] !== undefined) {
      requireString(forkedFrom, "entryId");
    }
    const mode = stringValue(forkedFrom, "mode");
    if (mode !== "before" && mode !== "at" && mode !== "clone") {
      throw new SessionSchemaError("invalid fork mode");
    }
  }
  return input as unknown as SessionHeader;
}

export function parseSessionItem(
  value: unknown,
  expectedSessionId?: string,
): SessionItem {
  const input = objectOf(value, "session item");
  if (input["schemaVersion"] !== 1) {
    throw new SessionSchemaError("unsupported session schema version");
  }
  const sessionId = requireString(input, "sessionId");
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw new SessionSchemaError("session id does not match header");
  }
  requirePositiveInteger(input, "seq");
  requireString(input, "id");
  requireString(input, "timestamp");
  const kind = stringValue(input, "kind");
  if (kind === "entry") {
    const entryType = stringValue(input, "entryType");
    if (!ENTRY_TYPES.has(entryType)) {
      throw new SessionSchemaError("invalid session entry type");
    }
    objectOf(input["payload"], "entry payload");
    if (entryType === "tool_definitions" || entryType === "tool_catalog") {
      const payload = objectOf(input["payload"], "tool context payload");
      const message = objectOf(payload["message"], "tool context message");
      if (typeof message["content"] !== "string") throw new SessionSchemaError("tool context content must be text");
      if (entryType === "tool_definitions") {
        if (message["role"] !== "system" || !Array.isArray(message["toolDefinitions"])) throw new SessionSchemaError("invalid tool definitions message");
        for (const raw of message["toolDefinitions"]) {
          const definition = objectOf(raw, "loaded tool");
          requireString(definition, "version");
          const spec = objectOf(definition["spec"], "tool spec");
          requireString(spec, "name");
          if (typeof spec["description"] !== "string" || !Array.isArray(spec["promptGuidelines"]) || spec["promptGuidelines"].some(value => typeof value !== "string")) throw new SessionSchemaError("invalid tool spec");
          objectOf(spec["parameters"], "tool parameters");
          if (spec["catalog"] !== undefined) {
            const catalog = objectOf(spec["catalog"], "tool catalog metadata");
            for (const key of ["source", "originalName", "binding"]) requireString(catalog, key);
            if (catalog["exposure"] !== "direct" && catalog["exposure"] !== "deferred") throw new SessionSchemaError("invalid exposure");
          }
        }
      } else {
        if (message["role"] !== "user") throw new SessionSchemaError("invalid catalog message role");
        const catalog = objectOf(message["toolCatalog"], "tool catalog");
        if (catalog["mode"] !== "full" && catalog["mode"] !== "deferred") throw new SessionSchemaError("invalid tool mode");
        for (const version of Object.values(objectOf(catalog["tools"], "tool versions"))) if (typeof version !== "string") throw new SessionSchemaError("invalid tool version");
      }
    }
    return input as unknown as SessionEntry;
  }
  if (kind === "record") {
    const recordType = stringValue(input, "recordType");
    if (!RECORD_TYPES.has(recordType)) {
      throw new SessionSchemaError("invalid session record type");
    }
    const payload = objectOf(input["payload"], "record payload");
    if (recordType === "session_name_changed") {
      const title = payload["title"];
      if (typeof title !== "string") {
        throw new SessionSchemaError("invalid session name record");
      }
      try {
        if (normalizeSessionTitle(title) !== title) {
          throw new SessionSchemaError("session name must already be normalized");
        }
      } catch (error) {
        if (error instanceof SessionSchemaError) {
          throw error;
        }
        throw new SessionSchemaError("invalid session name record");
      }
    }
    return input as unknown as SessionRecord;
  }
  throw new SessionSchemaError("invalid session item kind");
}

export function validateSessionItems(
  items: readonly SessionItem[],
  header: SessionHeader,
): readonly SessionItem[] {
  let previousSeq = 0;
  for (const raw of items) {
    const item = parseSessionItem(raw, header.sessionId);
    if (item.seq <= previousSeq) {
      throw new SessionSchemaError("session item seq must be strictly increasing");
    }
    previousSeq = item.seq;
  }
  return items;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionSchemaError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value === "") {
    throw new SessionSchemaError(`${key} must be a non-empty string`);
  }
  return value;
}

function stringValue(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = requireString(input, key);
  return value;
}

function requirePositiveInteger(
  input: Record<string, unknown>,
  key: string,
): number {
  const value = input[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new SessionSchemaError(`${key} must be a positive integer`);
  }
  return value;
}
