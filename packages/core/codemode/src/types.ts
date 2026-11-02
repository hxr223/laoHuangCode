export type CodeModeJsonSchema = Record<string, unknown> | boolean;

export interface CodeModeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: CodeModeJsonSchema;
  readonly outputSchema?: CodeModeJsonSchema;
  execute(args: unknown, context: { signal: AbortSignal }): unknown | Promise<unknown>;
}

export interface CodeModeSandboxOptions {
  readonly tools?: readonly CodeModeTool[];
  readonly globals?: readonly CodeModeGlobal[];
  readonly timeoutMs?: number;
  readonly memoryLimitBytes?: number;
  readonly workerUrl?: string | URL;
  readonly wasm?: object | Promise<object>;
  readonly acquireWorker?: () => () => void;
  readonly onWorkerStarted?: (exited: Promise<void>) => void;
}

export interface CodeModeGlobal extends CodeModeTool {
  readonly spread?: boolean;
}

export interface CodeModeExecuteOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onOutput?: (item: CodeModeOutputItem) => void;
  readonly store?: Readonly<Record<string, unknown>>;
}

export type CodeModeImageSource = { readonly data: string; readonly mimeType: string }
  | { readonly attachment_id: string; readonly view?: Record<string, unknown> };

export type CodeModeOutputItem = {
  readonly type: "text";
  readonly text: string;
  readonly console?: boolean;
} | ({ readonly type: "image" } & CodeModeImageSource);

export interface CodeModeCall {
  readonly id: number;
  readonly name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  durationMs: number;
}

export interface CodeModeError {
  readonly kind: "script" | "timeout" | "aborted" | "sandbox";
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
}

export interface CodeModeStoreWrites {
  readonly set: Readonly<Record<string, unknown>>;
  readonly delete: readonly string[];
}

export type CodeModeResult = {
  readonly output: readonly CodeModeOutputItem[];
  readonly calls: readonly CodeModeCall[];
  readonly durationMs: number;
} & ({ readonly ok: true; readonly value: unknown; readonly storeWrites: CodeModeStoreWrites } | { readonly ok: false; readonly error: CodeModeError });
