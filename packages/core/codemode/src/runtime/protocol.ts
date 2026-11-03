import type { CodeModeOutputItem } from "../types.ts";

export interface VmStartData {
  readonly code: string;
  readonly memoryLimitBytes: number;
  readonly store: Readonly<Record<string, string>>;
  readonly globals: readonly { name: string; spread: boolean }[];
  readonly tools: readonly { name: string; jsName: string; description?: string }[];
}

export interface WorkerData extends VmStartData {
  readonly wasm: object;
  readonly interrupt: SharedArrayBuffer;
}

export type WorkerToHostMessage =
  | { type: "call"; id: number; target: "tool" | "global"; name: string; args?: string }
  | { type: "output"; item: CodeModeOutputItem }
  | { type: "done"; ok: true; value?: string; writes: string }
  | { type: "done"; ok: false; error: string }
  | { type: "crash"; message: string };

export interface HostToWorkerMessage {
  type: "result";
  id: number;
  ok: boolean;
  payload?: string;
}

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "output": {
      if (!message.item || typeof message.item !== "object") return false;
      const item = message.item as Record<string, unknown>;
      if (item.type === "text") return typeof item.text === "string" && (item.console === undefined || typeof item.console === "boolean");
      if (item.type !== "image") return false;
      if (typeof item.data === "string") return typeof item.mimeType === "string" && item.data.length > 0 && item.attachment_id === undefined;
      return typeof item.attachment_id === "string" && item.attachment_id.length > 0 &&
        (item.view === undefined || typeof item.view === "object" && item.view !== null && !Array.isArray(item.view));
    }
    case "call": return Number.isSafeInteger(message.id) && Number(message.id) > 0 && (message.target === "tool" || message.target === "global") && typeof message.name === "string" && (message.args === undefined || typeof message.args === "string");
    case "done": return message.ok === true ? (message.value === undefined || typeof message.value === "string") && typeof message.writes === "string" : message.ok === false && typeof message.error === "string";
    case "crash": return typeof message.message === "string";
    default: return false;
  }
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "result" && Number.isSafeInteger(message.id) && Number(message.id) > 0 && typeof message.ok === "boolean" && (message.payload === undefined || typeof message.payload === "string");
}

export function isNodeWatchMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "watch:import" && keys[0] !== "watch:require") return false;
  const paths = (value as Record<string, unknown>)[keys[0]];
  return Array.isArray(paths) && paths.every(path => typeof path === "string");
}
