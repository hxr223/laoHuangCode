# Pi-AI Model Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written OpenAI-compatible model stack with a typed LaoHuang model contract backed by pi-ai, including native tool declaration/call/result conversion, replay-safe history, CLI integration, and DSML protocol-leak rejection.

**Architecture:** `@laohuang/llm` owns provider-neutral messages, tool calls, results, events, usage, errors, and Model Runtime. A new `@laohuang/llm-pi-ai` package is the only package that imports pi-ai and performs bidirectional conversion; Agent Runtime, Tool Runtime, local configuration, Session, and TUI retain their existing ownership while their model-facing call sites migrate to the new contract. The old `@laohuang/llm-openai-compatible` package and direct OpenAI SDK dependency are removed after every caller is migrated.

**Tech Stack:** TypeScript 5.5+, Node.js `>=22.19.0`, npm workspaces, Node built-in test runner, esbuild, `@earendil-works/pi-ai@^0.83.0`.

**Spec:** `docs/superpowers/specs/2026-08-25-pi-ai-model-adaptation-design.md`

## Global Constraints

- The completed product uses one model stack; `packages/llm/llm-openai-compatible` must be deleted.
- Only `packages/llm/llm-pi-ai` may import `@earendil-works/pi-ai`.
- The public CLI runtime and root workspace require Node.js `>=22.19.0`.
- The public CLI depends on `@earendil-works/pi-ai@^0.83.0` and does not depend directly on `openai`.
- Current OpenAI and DeepSeek profile, API-key, optional `base_url`, `/model`, `/login`, and `/logout` behavior must remain available.
- Do not claim another provider as supported without configuration, authentication, request/response conversion, and a real-provider contract test.
- `read`, `write`, `edit`, and `bash` execution, permissions, confinement, cancellation, output limits, and serial/parallel policy remain owned by the existing tool packages.
- Textual DSML is never executed; a complete DSML tool envelope terminates as a sanitized `protocol` model error.
- Use strict TypeScript. Avoid `any` unless no reasonable typed alternative exists.
- Use top-level imports. Do not use inline dynamic imports or dynamic type imports unless runtime behavior requires them.
- Keep directly executed TypeScript erasable: no `enum`, `namespace`/`module`, parameter properties, `import =`, or `export =`.
- Do not edit generated or packaged artifacts such as `dist/` or `.build/`.
- Do not run real provider calls unless the user explicitly asks and provides the corresponding environment key.
- After code changes, run `npm run build` and `npm test`.
- Do not execute a commit step unless the user explicitly authorizes commits.

---

## File structure and ownership

Create:

```text
packages/llm/llm-pi-ai/
├── package.json       # private workspace metadata and pi-ai dependency
├── tsconfig.json      # project reference to llm
└── src/
    ├── adapter.ts     # provider/model resolution and ModelAdapter implementation
    ├── context.ts     # LaoHuang request history -> pi-ai Context
    ├── index.ts       # public factory and types
    ├── replay.ts      # opaque versioned continuation state
    └── stream.ts      # pi-ai events -> LaoHuang ModelResult/events
```

Modify by responsibility:

```text
packages/llm/llm/src/model-contracts.ts       # neutral domain vocabulary
packages/llm/llm/src/model-runtime.ts         # typed events and result flow
packages/core/tools/src/index.ts              # neutral ToolSpec/ToolCall exposure
packages/core/tools/src/tool-runtime.ts       # neutral ToolCall dispatch
packages/core/agent-runtime/src/agent.ts      # typed route/history and model switch
packages/core/agent-runtime/src/core/agent-step-runner.ts
packages/core/agent-runtime/src/core/history-committer.ts
apps/cli/src/main.ts                          # one long-lived pi-ai Adapter
apps/cli/src/model-selection.ts               # catalog selection without SDK clients
apps/cli/src/semantic-classifier.ts           # shared Model Runtime
apps/cli/src/commands.ts                      # model switch without Adapter replacement
apps/cli/src/args.ts                          # neutral provider validation
```

Delete after migration:

```text
packages/llm/llm-openai-compatible/package.json
packages/llm/llm-openai-compatible/tsconfig.json
packages/llm/llm-openai-compatible/src/client.ts
packages/llm/llm-openai-compatible/src/index.ts
packages/llm/llm-openai-compatible/src/model-stream.ts
packages/llm/llm-openai-compatible/src/openai-compatible-adapter.ts
packages/llm/llm-openai-compatible/src/providers.ts
scripts/client.test.ts
scripts/providers.test.ts
```

Rewrite the existing model/Agent/CLI tests rather than adding a parallel legacy suite.

---

### Task 1: Introduce The Typed LaoHuang Model And Tool Contracts

**Files:**
- Modify: `packages/core/tools/src/index.ts`
- Modify: `packages/core/tools/src/tool-runtime.ts`
- Modify: `packages/llm/llm/src/model-contracts.ts`
- Modify: `packages/llm/llm/src/model-runtime.ts`
- Modify: `packages/core/runtime-protocol/src/runtime-events.ts`
- Modify: `scripts/tools.test.ts`
- Modify: `scripts/model-runtime.test.ts`
- Modify: `scripts/model-adapter.test.ts`

**Interfaces:**
- Consumes: existing `CancelToken`, `ToolSpec`, `ToolResult`, and runtime event names.
- Produces: `ToolCall`, `ModelMessage`, `AssistantModelMessage`, `ToolResultModelMessage`, `ModelReplayEnvelope`, `ModelEvent`, `ModelUsage`, `ModelResult`, `ModelProviderInfo`, `ModelInfo`, and the revised `ModelAdapter`.

- [ ] **Step 1: Write failing tests for neutral tool and message shapes**

Replace Chat-wire assertions in `scripts/tools.test.ts` with:

```ts
const registry = new ToolRegistry([echoTool]);
assert.deepEqual(registry.definitions, [{
  name: "echo",
  description: "Echo text",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  promptGuidelines: [],
}]);
```

Add typed-history assertions to `scripts/model-adapter.test.ts`:

```ts
const assistant: AssistantModelMessage = {
  role: "assistant",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  content: [
    { type: "reasoning", text: "inspect first" },
    {
      type: "tool-call",
      call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
    },
  ],
  replay: { adapter: "pi-ai", version: 1, state: { responseId: "r1" } },
};

assert.deepEqual(portableModelMessage(assistant), {
  role: "assistant",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  content: assistant.content,
});
```

- [ ] **Step 2: Run focused tests and verify the old wire contract fails**

Run:

```bash
node --test scripts/tools.test.ts scripts/model-adapter.test.ts scripts/model-runtime.test.ts
```

Expected: fail because `ToolRegistry.definitions` still returns the OpenAI `function` envelope and the new model types/functions do not exist.

- [ ] **Step 3: Replace the model-facing tool envelope**

Change `packages/core/tools/src/index.ts` to expose:

```ts
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolRegistryLike {
  readonly definitions: readonly ToolSpec[];
  readonly orderedSpecs: readonly ToolSpec[];
  executionMode(name: string): ToolExecutionMode | undefined;
  execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolExecutionContextLike,
  ): Promise<ToolResult> | ToolResult;
}

get definitions(): ToolSpec[] {
  return this.orderedSpecs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    promptGuidelines: [...spec.promptGuidelines],
  }));
}
```

Update `ToolRuntime` to read `call.name` and `call.arguments`; preserve its existing JSON parsing, batch ordering, cancellation, callbacks, and execution-mode decisions.

- [ ] **Step 4: Define the neutral model vocabulary**

Replace Chat-specific `AssembledFunction`, `AssembledToolCall`,
`toolCallToDict()`, `StreamResult.messageDict()`, and
`Array<Record<string, unknown>>` history with these exported contracts in
`model-contracts.ts`:

```ts
export interface SystemModelMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserModelMessage {
  readonly role: "user";
  readonly content: string;
}

export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface ReasoningContentBlock {
  readonly type: "reasoning";
  readonly text: string;
}

export interface ToolCallContentBlock {
  readonly type: "tool-call";
  readonly call: ToolCall;
}

export type AssistantContentBlock =
  | TextContentBlock
  | ReasoningContentBlock
  | ToolCallContentBlock;

export interface ModelReplayEnvelope {
  readonly adapter: string;
  readonly version: number;
  readonly state: unknown;
}

export interface AssistantModelMessage {
  readonly role: "assistant";
  readonly provider: string;
  readonly model: string;
  readonly content: readonly AssistantContentBlock[];
  readonly replay?: ModelReplayEnvelope;
}

export interface ToolResultModelMessage {
  readonly role: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
}

export type ModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | AssistantModelMessage
  | ToolResultModelMessage;

export type ModelFinishReason = "stop" | "tool-calls" | "max-tokens";

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "response-validating" };
```

Define `ModelRequest`, `ModelResult`, catalog metadata, and Adapter exactly as:

```ts
export interface ModelRequest {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly toolChoice: "auto" | "none";
  readonly temperature?: number;
  readonly requestId?: string;
  readonly cancelToken?: CancelToken;
  readonly isRequestActive?: (requestId: string) => boolean;
  readonly onEvent?: (event: ModelEvent) => void;
  readonly onRequestOpened?: () => boolean | void;
}

export interface ModelResult {
  readonly requestId: string;
  readonly message: AssistantModelMessage;
  readonly finishReason: ModelFinishReason;
  readonly usage: ModelUsage;
}

export interface ModelProviderInfo {
  readonly id: string;
  readonly name: string;
}

export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
}

export interface ModelAdapter {
  readonly name: string;
  runAttempt(request: ModelRequest): Promise<ModelResult>;
  listProviders(): readonly ModelProviderInfo[];
  listModels(provider: string): readonly ModelInfo[];
}
```

Add `"protocol"` to `ModelErrorKind`. Implement
`portableModelMessage(message)` so only `AssistantModelMessage.replay` is
removed; visible blocks and tool-result correlation remain unchanged.

- [ ] **Step 5: Update Model Runtime's typed event bridge**

Make `ModelRuntime.complete()` pass the new route, messages, ToolSpecs,
temperature, cancellation, and `onEvent`. Translate typed events into existing
runtime-protocol event names:

```ts
function forwardEvent(
  event: ModelEvent,
  handler: ModelRuntimeEventHandler | null | undefined,
): void {
  if (event.type === "text-delta") {
    handler?.("model_text_delta", { text: event.text });
  } else if (event.type === "reasoning-delta") {
    handler?.("model_reasoning_delta", { text: event.text });
  } else if (event.type === "tool-call-delta") {
    handler?.("model_tool_call_delta", {
      index: event.index,
      id: event.id,
      name: event.name ?? null,
      arguments: event.argumentsDelta,
    });
  } else {
    handler?.("model_response_validating", {});
  }
}
```

Return the typed `ModelResult`; do not reconstruct a message dictionary.

- [ ] **Step 6: Run focused tests and verify the neutral contract passes**

Run:

```bash
node --test scripts/tools.test.ts scripts/model-adapter.test.ts scripts/model-runtime.test.ts
```

Expected: pass for neutral shapes, portable replay removal, cancellation preflight, typed event forwarding, and error normalization.

- [ ] **Step 7: Commit the contract change if commits are authorized**

```bash
git add packages/core/tools/src/index.ts packages/core/tools/src/tool-runtime.ts packages/llm/llm/src/model-contracts.ts packages/llm/llm/src/model-runtime.ts packages/core/runtime-protocol/src/runtime-events.ts scripts/tools.test.ts scripts/model-adapter.test.ts scripts/model-runtime.test.ts
git commit -m "refactor: define provider-neutral model contracts"
```

---

### Task 2: Add Pi Context And Replay Conversion

**Files:**
- Create: `packages/llm/llm-pi-ai/package.json`
- Create: `packages/llm/llm-pi-ai/tsconfig.json`
- Create: `packages/llm/llm-pi-ai/src/context.ts`
- Create: `packages/llm/llm-pi-ai/src/replay.ts`
- Create: `packages/llm/llm-pi-ai/src/index.ts`
- Create: `scripts/pi-ai-context.test.ts`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `ModelRequest`, `ModelMessage`, `AssistantModelMessage`, `ToolSpec`, and pi-ai `Context`, `Message`, `AssistantMessage`, and `Tool`.
- Produces: `toPiContext(request)`, `toPiAssistant(message, route)`, `toReplayEnvelope(message)`, and `PiReplayStateV1`.

- [ ] **Step 1: Add workspace metadata and refresh the lockfile without scripts**

Create `packages/llm/llm-pi-ai/package.json`:

```json
{
  "name": "@laohuang/llm-pi-ai",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "@earendil-works/pi-ai": "^0.83.0",
    "@laohuang/llm": "0.0.0"
  }
}
```

Create `tsconfig.json` extending `../../../tsconfig.base.json`, using `src` as
`rootDir`, `dist` as `outDir`, and a project reference to llm. Add the workspace
to root `tsconfig.json`.

Refresh dependency metadata:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: exit 0; no lifecycle script runs.

- [ ] **Step 2: Write failing context and replay tests**

Create `scripts/pi-ai-context.test.ts` with a request containing system, user,
assistant tool-call, and tool-result messages:

```ts
const request: ModelRequest = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      content: [{
        type: "tool-call",
        call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
      }],
    },
    {
      role: "tool-result",
      toolCallId: "call-1",
      toolName: "read",
      content: "contents",
      isError: false,
    },
  ],
  tools: [{
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: [],
  }],
  toolChoice: "auto",
};

const context = toPiContext(request);
assert.equal(context.systemPrompt, "system");
assert.deepEqual(context.tools, [{
  name: "read",
  description: "Read a file",
  parameters: request.tools[0]!.parameters,
}]);
assert.equal(context.messages.at(-1)?.role, "toolResult");
```

Add assertions that `toolChoice: "none"` omits `context.tools`, duplicate
system messages throw a `ModelError` with kind `protocol`, matching replay
restores signatures, and foreign/malformed replay degrades to visible content.

- [ ] **Step 3: Run the context test and verify it fails**

Run:

```bash
node --test scripts/pi-ai-context.test.ts
```

Expected: fail because `llm-pi-ai/context.ts` and `replay.ts` do not exist.

- [ ] **Step 4: Implement request conversion**

Implement `toolsOf()` and `toPiContext()` in `context.ts`:

```ts
function toolsOf(request: ModelRequest): PiTool[] | undefined {
  if (request.toolChoice === "none" || request.tools.length === 0) return undefined;
  return request.tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

export function toPiContext(request: ModelRequest): PiContext {
  const systems = request.messages.filter(
    (message): message is SystemModelMessage => message.role === "system",
  );
  if (systems.length > 1) {
    throw new ModelError("model history contains more than one system message", {
      kind: "protocol",
    });
  }
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => toPiMessage(message, request.provider, request.model));
  const tools = toolsOf(request);
  return {
    ...(systems[0] === undefined ? {} : { systemPrompt: systems[0].content }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}
```

Convert tool results exactly to:

```ts
{
  role: "toolResult",
  toolCallId: message.toolCallId,
  toolName: message.toolName,
  content: [{ type: "text", text: message.content || "(no output)" }],
  isError: message.isError,
  timestamp: 0,
}
```

- [ ] **Step 5: Implement versioned replay conversion**

Define `PiReplayStateV1` in `replay.ts` with response fields `api`, `provider`,
`model`, optional `responseModel`, optional `responseId`, `stopReason`, and
index-aligned block metadata. `toReplayEnvelope()` must return:

```ts
{
  adapter: "pi-ai",
  version: 1,
  state: {
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseModel: message.responseModel,
    responseId: message.responseId,
    stopReason: message.stopReason,
    blocks,
  },
}
```

`toPiAssistant()` must validate adapter, version, provider, model, block count,
block tags, and signature primitive types before restoring replay metadata. On
invalid or foreign replay, return a provider-neutral pi-ai assistant message
using the LaoHuang visible blocks, zero usage, timestamp `0`, and no signatures.

- [ ] **Step 6: Run the context/replay test and verify it passes**

Run:

```bash
node --test scripts/pi-ai-context.test.ts
```

Expected: pass for tool declaration conversion, tool-result correlation,
forced-final omission, replay restoration, and replay degradation.

- [ ] **Step 7: Commit context/replay conversion if commits are authorized**

```bash
git add package.json package-lock.json tsconfig.json packages/llm/llm-pi-ai/package.json packages/llm/llm-pi-ai/tsconfig.json packages/llm/llm-pi-ai/src/context.ts packages/llm/llm-pi-ai/src/replay.ts packages/llm/llm-pi-ai/src/index.ts scripts/pi-ai-context.test.ts
git commit -m "feat: add pi-ai context conversion"
```

---

### Task 3: Implement Pi Stream Translation And Model Adapter

**Files:**
- Create: `packages/llm/llm-pi-ai/src/stream.ts`
- Create: `packages/llm/llm-pi-ai/src/adapter.ts`
- Modify: `packages/llm/llm-pi-ai/src/index.ts`
- Create: `scripts/pi-ai-stream.test.ts`
- Create: `scripts/pi-ai-adapter.test.ts`

**Interfaces:**
- Consumes: `toPiContext()`, `toReplayEnvelope()`, pi-ai `builtinModels()`, `Models.streamSimple()`, and typed LaoHuang model contracts.
- Produces: `PiAiAdapter implements ModelAdapter`, `createPiAiAdapter(options)`, `consumePiEvents(events, request, emit)`, catalog listing, cancellation, and DSML protocol detection.

- [ ] **Step 1: Write failing stream-event tests**

Create `scripts/pi-ai-stream.test.ts` with a fake async iterable that emits
`start`, text/thinking/tool-call fragments, and `done`. Assert:

```ts
const result = await consumePiEvents(events, request, emitted.push.bind(emitted));
assert.equal(result.finishReason, "tool-calls");
assert.deepEqual(result.message.content, [
  { type: "reasoning", text: "inspect" },
  {
    type: "tool-call",
    call: { id: "call-1", name: "read", arguments: "{\"path\":\"a.txt\"}" },
  },
]);
assert.deepEqual(emitted.map((event) => event.type), [
  "reasoning-delta",
  "tool-call-delta",
  "response-validating",
]);
```

Add cases for final text, parallel ToolCalls, usage, `error`, `aborted`, stream
closure without a terminal event, missing call id/name, and non-object tool
arguments.

- [ ] **Step 2: Write failing adapter and DSML tests**

Create `scripts/pi-ai-adapter.test.ts` using a fake pi-ai provider registered in
a test `Models` collection. Assert unknown providers/models fail before stream
invocation, `baseUrl` overrides only the request-local model, API keys reach
stream options, and `CancelToken.signal` reaches the provider.

Add the regression:

```ts
const dsml = '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="bash">'
  + '<｜｜DSML｜｜parameter name="command">pwd</｜｜DSML｜｜parameter>'
  + '</｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>';
await assert.rejects(
  adapter.runAttempt(requestReturning(dsml)),
  (error: unknown) => error instanceof ModelError && error.kind === "protocol",
);
assert.equal(executedToolCount, 0);
```

Also assert `The string DSML is documented here.` remains a valid text result.

- [ ] **Step 3: Run both focused tests and verify they fail**

Run:

```bash
node --test scripts/pi-ai-stream.test.ts scripts/pi-ai-adapter.test.ts
```

Expected: fail because stream translation and the Adapter do not exist.

- [ ] **Step 4: Implement stream translation and validation**

Implement one exhaustive switch over `AssistantMessageEvent`. Accumulate
content by `contentIndex`, emit typed deltas, and construct `ToolCall.arguments`
with `JSON.stringify(event.toolCall.arguments)`. On `done`, emit
`response-validating`, validate content/tool calls/usage, attach
`toReplayEnvelope(event.message)`, then return `ModelResult`.

Map pi-ai terminal reasons exactly:

```ts
function finishReasonOf(message: PiAssistantMessage): ModelFinishReason {
  if (message.stopReason === "stop") return "stop";
  if (message.stopReason === "toolUse") return "tool-calls";
  if (message.stopReason === "length") return "max-tokens";
  if (message.stopReason === "aborted") {
    throw new ModelStreamCancelled(message.errorMessage ?? "model request aborted");
  }
  throw modelErrorFromPi(message.errorMessage ?? "pi-ai model request failed");
}
```

Reject a source iterable that ends without `done`/`error`. Validate usage as
finite non-negative integers before returning it.

- [ ] **Step 5: Implement the pi-ai Adapter and catalog**

Construct one `Models` collection from `builtinModels()` and restrict its public
catalog to `enabledProviders`. Implement:

```ts
export interface PiAiAdapterOptions {
  readonly enabledProviders: readonly string[];
  readonly resolveApiKey: (
    provider: string,
  ) => string | null | Promise<string | null>;
}

export function createPiAiAdapter(options: PiAiAdapterOptions): ModelAdapter {
  return new PiAiAdapter(options, builtinModels());
}
```

`runAttempt()` must:

1. reject a disabled/unknown provider;
2. resolve the exact model from the collection;
3. copy the model when `request.baseUrl` is present;
4. resolve and trim the API key without logging it;
5. check cancellation and stale-request state before opening;
6. honor `onRequestOpened() === false` as cancellation;
7. call `models.streamSimple(model, toPiContext(request), { apiKey, signal,
   temperature, maxRetries: 0 })` using only fields accepted by local pi-ai
   types;
8. consume the stream through `consumePiEvents()`;
9. recheck request activity before returning.

Implement `listProviders()` and `listModels(provider)` from the same collection.
Do not maintain a second model-id list.

- [ ] **Step 6: Add guarded textual DSML detection**

After a terminal `stop`, join visible text blocks and test only the complete
trimmed envelope:

```ts
const DSML_TOOL_ENVELOPE =
  /^<｜｜DSML｜｜tool_calls>\s*<｜｜DSML｜｜invoke\b[\s\S]*<\/｜｜DSML｜｜invoke>\s*<\/｜｜DSML｜｜tool_calls>$/;

if (DSML_TOOL_ENVELOPE.test(text.trim())) {
  throw new ModelError(
    `provider ${request.provider}/${request.model} returned textual tool protocol`,
    { kind: "protocol", hadDelta: text.length > 0 },
  );
}
```

Do not include DSML arguments or the complete output in the error.

- [ ] **Step 7: Run focused tests and verify they pass**

Run:

```bash
node --test scripts/pi-ai-stream.test.ts scripts/pi-ai-adapter.test.ts
```

Expected: pass for text/reasoning/ToolCall streams, errors, cancellation,
catalog lookup, base URL override, API-key injection, DSML rejection, and normal
DSML prose.

- [ ] **Step 8: Commit the Adapter if commits are authorized**

```bash
git add packages/llm/llm-pi-ai/src/adapter.ts packages/llm/llm-pi-ai/src/stream.ts packages/llm/llm-pi-ai/src/index.ts scripts/pi-ai-stream.test.ts scripts/pi-ai-adapter.test.ts
git commit -m "feat: add pi-ai model adapter"
```

---

### Task 4: Migrate Agent History And The Tool Loop

**Files:**
- Modify: `packages/core/agent-runtime/src/agent.ts`
- Modify: `packages/core/agent-runtime/src/core/agent-step-runner.ts`
- Modify: `packages/core/agent-runtime/src/core/history-committer.ts`
- Modify: `scripts/agent.test.ts`
- Modify: `scripts/agent-step-runner.test.ts`
- Modify: `scripts/project-instructions.test.ts`
- Modify: `scripts/system-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 `ModelMessage`, `ModelResult`, `ToolCall`, `ToolResultModelMessage`, `portableModelMessage()`, and unchanged `ToolRuntime` execution.
- Produces: typed Agent history, typed tool-result commits, forced-final tool omission, and replay-safe model switching.

- [ ] **Step 1: Rewrite Agent tests around typed history**

Change stub Adapters to return:

```ts
function toolCallResult(id = "call-1"): ModelResult {
  return {
    requestId: "request-1",
    finishReason: "tool-calls",
    usage: { inputTokens: 10, outputTokens: 4 },
    message: {
      role: "assistant",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      content: [{
        type: "tool-call",
        call: { id, name: "read", arguments: "{\"path\":\"answer.txt\"}" },
      }],
      replay: { adapter: "pi-ai", version: 1, state: { responseId: "r1" } },
    },
  };
}
```

Assert the second request history is:

```ts
assert.deepEqual(adapter.requests[1]?.messages.map((message) => message.role), [
  "system",
  "user",
  "assistant",
  "tool-result",
]);
assert.deepEqual(adapter.requests[1]?.messages.at(-1), {
  role: "tool-result",
  toolCallId: "call-1",
  toolName: "read",
  content: JSON.stringify({ ok: true, content: "answer" }),
  isError: false,
});
```

Add a forced-final assertion that the next request has `toolChoice === "none"`
and retains the complete typed history.

- [ ] **Step 2: Run Agent tests and verify Chat-wire assumptions fail**

Run:

```bash
node --test scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/project-instructions.test.ts scripts/system-prompt.test.ts
```

Expected: fail because Agent history and `HistoryCommitter` still use records,
`tool_calls`, and `role: "tool"`.

- [ ] **Step 3: Convert HistoryCommitter to typed messages**

Set `HistoryMessage = ModelMessage`. Commit user input as
`{ role: "user", content }`. Commit tool results with their matching calls:

```ts
commitToolResults(
  toolCalls: readonly ToolCall[],
  toolResults: readonly ToolResult[],
): void {
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index]!;
    const result = toolResults[index]!;
    this.messages.push({
      role: "tool-result",
      toolCallId: call.id,
      toolName: call.name,
      content: JSON.stringify(result),
      isError: result.ok !== true,
    });
  }
}
```

Preserve existing commit hooks, rollback semantics, safe-point ordering, and
cancellation checks.

- [ ] **Step 4: Convert AgentStepRunner result handling**

Pass `provider` and optional `baseUrl` into `ModelRuntime.complete()`. Read
tool calls from typed blocks:

```ts
const toolCalls = result.message.content
  .filter(
    (block): block is ToolCallContentBlock => block.type === "tool-call",
  )
  .map((block) => block.call);

const text = result.message.content
  .filter((block): block is TextContentBlock => block.type === "text")
  .map((block) => block.text)
  .join("");
```

Commit `result.message` directly after validation. Delete `messageDict()` use.
Pass `toolChoice: forceFinal ? "none" : "auto"`; the pi Adapter owns omission
of tools from its request.

- [ ] **Step 5: Convert CodingAgent route and switching behavior**

Store `messages: ModelMessage[]`, initialize with the existing system prompt,
and add `baseUrl: string | null` to `CodingAgentOptions`. Keep one
`ModelAdapter`/`ModelRuntime` for the Agent lifetime.

Replace `switchModel()` with:

```ts
switchModel(options: {
  provider: string;
  model: string;
  baseUrl: string | null;
}): void {
  const previousModel = this.model;
  const previousProvider = this.provider;
  this.messages = this.messages.map(portableModelMessage);
  this.provider = options.provider;
  this.model = options.model;
  this.baseUrl = options.baseUrl;
  this.emit("model_switched", {
    provider: options.provider,
    model: options.model,
    previous_model: previousModel,
    previous_provider: previousProvider,
  });
}
```

Project-instruction updates continue to mutate the first system message's
`content`; they do not inspect provider fields.

- [ ] **Step 6: Run Agent tests and verify the migrated loop passes**

Run:

```bash
node --test scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/project-instructions.test.ts scripts/system-prompt.test.ts scripts/tools.test.ts
```

Expected: pass for text completion, single/parallel ToolCalls, ToolResults,
safe points, cancellation, guard policy, project instructions, forced-final,
and provider/model switching.

- [ ] **Step 7: Commit Agent migration if commits are authorized**

```bash
git add packages/core/agent-runtime/src/agent.ts packages/core/agent-runtime/src/core/agent-step-runner.ts packages/core/agent-runtime/src/core/history-committer.ts scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/project-instructions.test.ts scripts/system-prompt.test.ts
git commit -m "refactor: migrate agent history to neutral messages"
```

---

### Task 5: Migrate CLI Composition, Model Selection, And Classification

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/model-selection.ts`
- Modify: `apps/cli/src/semantic-classifier.ts`
- Modify: `apps/cli/src/commands.ts`
- Modify: `apps/cli/src/args.ts`
- Modify: `scripts/cli.test.ts`
- Modify: `scripts/model-selection.test.ts`
- Modify: `scripts/commands.test.ts`
- Modify: `scripts/command-entry.test.ts`

**Interfaces:**
- Consumes: `createPiAiAdapter()`, `ModelAdapter.listProviders()`, `ModelAdapter.listModels()`, `ModelRuntime`, and existing local config/credential stores.
- Produces: one shared Adapter, configuration-only `ModelSelection`, model switching without client replacement, and a classifier with no direct SDK path.

- [ ] **Step 1: Rewrite model-selection tests without clients**

Use a fake catalog Adapter:

```ts
const catalog: Pick<ModelAdapter, "listProviders" | "listModels"> = {
  listProviders: () => [
    { id: "deepseek", name: "DeepSeek" },
    { id: "openai", name: "OpenAI" },
  ],
  listModels: (provider) => provider === "deepseek"
    ? [{ provider, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }]
    : [{ provider, id: "gpt-5", name: "GPT-5" }],
};
```

Assert `ModelSelector.select()` returns only:

```ts
{
  config: {
    apiKey: "secret",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    provider: "deepseek",
  },
}
```

There must be no `client` or `modelAdapter` property.

- [ ] **Step 2: Rewrite semantic-classifier tests around ModelRuntime**

Provide a fake Adapter returning one text block:

```ts
const adapter = new StubAdapter(() => resultWithText(
  '{"strategy":"steer","confidence":0.91}',
));
const classifier = new SmallModelSemanticClassifier({
  modelRuntime: new ModelRuntime(adapter),
  route: {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
  },
});
```

Assert the classifier request uses `toolChoice: "none"`, `temperature: 0`, no
tools, and the same timeout/fail-closed behavior as today.

- [ ] **Step 3: Run focused CLI tests and verify old client wiring fails**

Run:

```bash
node --test scripts/model-selection.test.ts scripts/commands.test.ts scripts/command-entry.test.ts scripts/cli.test.ts
```

Expected: fail because production selection and classification still require an
OpenAI client and old provider registry.

- [ ] **Step 4: Convert ModelSelector to the neutral catalog**

Replace `createClient`, `createModelAdapter`, and `clientFactory` options with:

```ts
export interface ModelSelectorOptions {
  readonly credentials: CredentialStoreLike;
  readonly catalog: Pick<ModelAdapter, "listProviders" | "listModels">;
  readonly input: InputFn;
  readonly secretInput: InputFn;
  readonly output?: OutputFn;
}

export interface ModelSelection {
  readonly config: SelectionConfig;
}
```

Provider display names and model options come from the catalog. Keep current
API-key prompting/storage and manual model entry fallback. Reject a provider
not returned by `listProviders()`.

- [ ] **Step 5: Compose one pi-ai Adapter in main**

Create the Adapter after `CredentialStore`:

```ts
const modelAdapter = createPiAiAdapter({
  enabledProviders: ["deepseek", "openai"],
  resolveApiKey: (provider) => credentials.get(provider),
});
const modelRuntime = new ModelRuntime(modelAdapter);
```

Pass the catalog to `ModelSelector`, the shared Adapter and route to
`CodingAgent`, and the shared Model Runtime/route to the classifier. Remove
`createClient`, `defaultAdapterRegistry`, `ChatClientLike`,
`ClientConnectionSettings`, and `clientFactory` from production composition and
`MainOptions`.

- [ ] **Step 6: Convert commands and classifier**

Make `/model` call:

```ts
agent.switchModel({
  provider: selection.config.provider,
  model: selection.config.model,
  baseUrl: selection.config.baseUrl,
});
classifier.configure({
  provider: selection.config.provider,
  model: selection.config.model,
  baseUrl: selection.config.baseUrl,
});
```

Make `SmallModelSemanticClassifier.classify()` call `ModelRuntime.complete()`
with two typed messages, no tools, `toolChoice: "none"`, and `temperature: 0`.
Join returned text blocks, parse JSON, apply the existing confidence threshold,
and return `null` for cancellation, timeout, model errors, or malformed JSON.

Provider completions in `commands.ts` and provider validation in `args.ts` must
come from injected catalog values; remove imports from the old Adapter package.

- [ ] **Step 7: Run focused CLI tests and verify they pass**

Run:

```bash
node --test scripts/model-selection.test.ts scripts/commands.test.ts scripts/command-entry.test.ts scripts/cli.test.ts
```

Expected: pass for initial selection, stored profiles, `/model`, `/login`,
`/logout`, classifier routing, missing keys, unknown routes, and model errors
without network access.

- [ ] **Step 8: Commit CLI migration if commits are authorized**

```bash
git add apps/cli/src/main.ts apps/cli/src/model-selection.ts apps/cli/src/semantic-classifier.ts apps/cli/src/commands.ts apps/cli/src/args.ts scripts/cli.test.ts scripts/model-selection.test.ts scripts/commands.test.ts scripts/command-entry.test.ts
git commit -m "refactor: route cli model calls through pi-ai"
```

---

### Task 6: Remove The OpenAI-Compatible Stack And Update Packaging

**Files:**
- Delete: `packages/llm/llm-openai-compatible/package.json`
- Delete: `packages/llm/llm-openai-compatible/tsconfig.json`
- Delete: `packages/llm/llm-openai-compatible/src/client.ts`
- Delete: `packages/llm/llm-openai-compatible/src/index.ts`
- Delete: `packages/llm/llm-openai-compatible/src/model-stream.ts`
- Delete: `packages/llm/llm-openai-compatible/src/openai-compatible-adapter.ts`
- Delete: `packages/llm/llm-openai-compatible/src/providers.ts`
- Delete: `scripts/client.test.ts`
- Delete: `scripts/providers.test.ts`
- Rewrite: `scripts/model-stream.test.ts`
- Rewrite: `scripts/model-adapter.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `apps/cli/tsconfig.json`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/build.mjs`

**Interfaces:**
- Consumes: migrated callers from Tasks 1-5 and `@laohuang/llm-pi-ai`.
- Produces: one production model stack, Node.js `>=22.19.0`, published pi-ai runtime dependency, and no direct OpenAI SDK dependency.

- [ ] **Step 1: Replace old stream tests with bridge tests**

Move any still-relevant assertions from `scripts/model-stream.test.ts` into
`scripts/pi-ai-stream.test.ts`: conflicting/incomplete ToolCalls, terminal
errors, missing terminal events, cancellation after deltas, stale request, and
usage validation. Delete assertions tied only to OpenAI
`choices[].delta.tool_calls` field assembly.

Run:

```bash
node --test scripts/pi-ai-stream.test.ts scripts/pi-ai-adapter.test.ts scripts/model-adapter.test.ts
```

Expected: pass before removing the old package.

- [ ] **Step 2: Remove old workspace source and tests**

Delete the seven files under `packages/llm/llm-openai-compatible`, then remove
the empty directories. Delete `scripts/client.test.ts`,
`scripts/providers.test.ts`, and the superseded `scripts/model-stream.test.ts`.

Verify deletion targets before applying patches:

```bash
rg --files packages/llm/llm-openai-compatible scripts | rg 'llm-openai-compatible|client\.test|providers\.test|model-stream\.test'
```

Expected before deletion: exactly the listed package files and three test
files. Expected after deletion: no output.

- [ ] **Step 3: Update manifests, Node floor, references, and bundle externals**

Set both root and `apps/cli/package.json` engines to:

```json
{ "node": ">=22.19.0" }
```

Set the public CLI runtime dependency to:

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "^0.83.0"
  }
}
```

Remove direct `openai` and `@laohuang/llm-openai-compatible` entries. Add
`@laohuang/llm-pi-ai` as a CLI development workspace input. Replace project
references to the deleted package with `llm-pi-ai`.

Change `apps/cli/build.mjs` to:

```ts
target: "node22.19",
external: ["@earendil-works/pi-ai", "@earendil-works/pi-ai/*"],
```

Refresh the lockfile:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: exit 0; lockfile contains pi-ai and no workspace entry for
`llm-openai-compatible`.

- [ ] **Step 4: Search for removed production symbols**

Run:

```bash
rg -n "@laohuang/llm-openai-compatible|ChatCompletionStreamer|OpenAICompatibleAdapter|createClient|chat\.completions" apps packages
```

Expected: no output.

Run:

```bash
rg -n "reasoning_content|tool_call_id|tool_calls" apps packages
```

Expected: no production wire fields. Any match must be an explicitly named
pi-ai protocol fixture under tests, not Agent/Tool/CLI source.

- [ ] **Step 5: Build and run the model/Agent/CLI test set**

Run:

```bash
npm run build
node --test scripts/pi-ai-context.test.ts scripts/pi-ai-stream.test.ts scripts/pi-ai-adapter.test.ts scripts/model-adapter.test.ts scripts/model-runtime.test.ts scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/model-selection.test.ts scripts/commands.test.ts scripts/cli.test.ts
```

Expected: build exits 0; every listed test passes without provider keys.

- [ ] **Step 6: Commit removal and packaging if commits are authorized**

```bash
git add package.json package-lock.json tsconfig.json apps/cli/package.json apps/cli/tsconfig.json apps/cli/build.mjs packages/llm/llm-pi-ai/package.json packages/llm/llm-pi-ai/tsconfig.json packages/llm/llm-pi-ai/src/adapter.ts packages/llm/llm-pi-ai/src/context.ts packages/llm/llm-pi-ai/src/index.ts packages/llm/llm-pi-ai/src/replay.ts packages/llm/llm-pi-ai/src/stream.ts scripts/pi-ai-context.test.ts scripts/pi-ai-stream.test.ts scripts/pi-ai-adapter.test.ts scripts/model-adapter.test.ts
git add packages/llm/llm-openai-compatible/package.json packages/llm/llm-openai-compatible/tsconfig.json packages/llm/llm-openai-compatible/src/client.ts packages/llm/llm-openai-compatible/src/index.ts packages/llm/llm-openai-compatible/src/model-stream.ts packages/llm/llm-openai-compatible/src/openai-compatible-adapter.ts packages/llm/llm-openai-compatible/src/providers.ts scripts/client.test.ts scripts/providers.test.ts scripts/model-stream.test.ts
git diff --cached --name-only
git commit -m "refactor: replace openai bridge with pi-ai"
```

---

### Task 7: Add The Optional Real-Provider Contract Test

**Files:**
- Create: `scripts/pi-ai-deepseek.e2e.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: public `createPiAiAdapter()`, `ModelRuntime`, and
  `DEEPSEEK_API_KEY` only when explicitly enabled.
- Produces: a self-skipping native ToolCall/ToolResult continuation test that distinguishes real-provider evidence from fake-stream coverage.

- [ ] **Step 1: Add an explicit e2e script that is not part of ordinary unit execution**

Add to root `package.json`:

```json
{
  "scripts": {
    "test:e2e:pi-ai": "LAOHUANG_RUN_PROVIDER_E2E=1 node --test scripts/pi-ai-deepseek.e2e.test.ts"
  }
}
```

At the top of the test, define the explicit opt-in guard:

```ts
const enabled = process.env["LAOHUANG_RUN_PROVIDER_E2E"] === "1";
const apiKey = process.env["DEEPSEEK_API_KEY"];
```

- [ ] **Step 2: Implement the real two-request contract**

Create the test with the guard. Inside its callback, construct an Adapter whose
resolver returns `apiKey`:

```ts
assert.ok(apiKey);
const adapter = createPiAiAdapter({
  enabledProviders: ["deepseek"],
  resolveApiKey: async () => apiKey,
});
const runtime = new ModelRuntime(adapter);
```

Inside that callback, send this first request:

```ts
const first = await runtime.complete({
  provider: "deepseek",
  model: "deepseek-v4-flash",
  messages: [
    { role: "system", content: "Use the supplied tool. Do not answer from memory." },
    { role: "user", content: "Call read_fixture for fixture.txt." },
  ],
  tools: [{
    name: "read_fixture",
    description: "Read one named fixture",
    parameters: {
      type: "object",
      properties: { path: { type: "string", const: "fixture.txt" } },
      required: ["path"],
      additionalProperties: false,
    },
    promptGuidelines: [],
  }],
  toolChoice: "auto",
});
```

Assert exactly one native ToolCall named `read_fixture`, append its assistant
message plus:

```ts
{
  role: "tool-result",
  toolCallId: call.id,
  toolName: call.name,
  content: "fixture-value-7429",
  isError: false,
}
```

Send the second request with `toolChoice: "none"`. Assert final visible text
contains `fixture-value-7429` and does not match the DSML envelope detector.

- [ ] **Step 3: Verify the test self-skips without credentials**

Run:

```bash
node --test scripts/pi-ai-deepseek.e2e.test.ts
```

Expected: one skipped test and zero network calls.

- [ ] **Step 4: Document but do not run the opted-in command**

Record this verification command in the test header and final implementation
handoff:

```bash
npm run test:e2e:pi-ai
```

Expected when explicitly authorized with `DEEPSEEK_API_KEY`: pass the native
ToolCall and ToolResult continuation contract. Do not run it during ordinary
implementation.

- [ ] **Step 5: Commit the e2e contract if commits are authorized**

```bash
git add package.json scripts/pi-ai-deepseek.e2e.test.ts
git commit -m "test: add pi-ai deepseek contract"
```

---

### Task 8: Update Architecture, Security, Configuration, And Publishing Docs

**Files:**
- Modify: `README.md`
- Modify: `apps/cli/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/configuration.md`
- Modify: `docs/security.md`
- Modify: `docs/npm-distribution.md`
- Modify: `docs/publishing.md`
- Modify: `docs/superpowers/specs/2026-08-25-workspace-package-architecture-design.md`

**Interfaces:**
- Consumes: the completed package/runtime behavior from Tasks 1-7.
- Produces: current-state documentation with one package graph, one runtime dependency contract, explicit provider-support boundaries, and no obsolete OpenAI SDK claims.

- [ ] **Step 1: Write the exact package ownership update**

Replace the old package row and dependency graph node with:

```markdown
| `packages/llm/llm-pi-ai` | `@laohuang/llm-pi-ai` | Bidirectional conversion between LaoHuang model contracts and pi-ai, provider/model lookup, replay metadata, streaming, cancellation, and normalized model failures. |
```

Document that `@laohuang/llm` owns neutral contracts, only `llm-pi-ai` imports
pi-ai, Agent Runtime owns the tool loop, and Tool Runtime owns execution.

- [ ] **Step 2: Update configuration and security text**

In `docs/configuration.md`, replace “new client creation/rebuild” with “the next
request resolves the selected route and current API key through the shared
Adapter.” State that switching routes preserves visible history and removes
provider-private replay state.

In `docs/security.md`, add these exact guarantees:

```markdown
- `llm-pi-ai` receives API keys through an injected resolver and does not read or write credential files.
- Model errors and DSML protocol-leak diagnostics never include API keys, authorization headers, complete prompts, complete model output, or raw tool results.
- Textual DSML is treated as untrusted assistant text and is never dispatched to Tool Runtime.
```

- [ ] **Step 3: Update runtime and publishing requirements**

Change Node references in README, distribution, publishing, and workspace
architecture docs to `>=22.19.0`. Replace “official OpenAI SDK is the only
runtime dependency” with “`@earendil-works/pi-ai@^0.83.0` is the model runtime
dependency and internal `@laohuang/*` packages remain bundled.”

Document that only OpenAI and DeepSeek are currently product-supported routes;
the presence of additional models in pi-ai's installed catalog is not a support
claim.

- [ ] **Step 4: Search documentation for obsolete current-state claims**

Run:

```bash
rg -n "llm-openai-compatible|official `?openai|OpenAI SDK|Node\.js 18|Node 18|node18" README.md apps/cli/README.md docs --glob '!superpowers/plans/*.md'
```

Expected: no obsolete current-state claim. Historical plans may retain their
original text; the current workspace architecture spec must be updated.

- [ ] **Step 5: Commit documentation if commits are authorized**

```bash
git add README.md apps/cli/README.md docs/architecture.md docs/configuration.md docs/security.md docs/npm-distribution.md docs/publishing.md docs/superpowers/specs/2026-08-25-workspace-package-architecture-design.md
git commit -m "docs: describe pi-ai model architecture"
```

---

### Task 9: Full Verification And Acceptance Audit

**Files:**
- Modify only files already touched by Tasks 1-8 if verification exposes a defect.

**Interfaces:**
- Consumes: repository build, test, version, package-smoke, and TUI-smoke commands.
- Produces: evidence that the complete product contract passes without real provider calls.

- [ ] **Step 1: Verify forbidden production dependencies are gone**

Run:

```bash
rg -n "@laohuang/llm-openai-compatible|ChatCompletionStreamer|OpenAICompatibleAdapter|chat\.completions" apps packages
```

Expected: no output.

Run:

```bash
rg -n "@earendil-works/pi-ai" packages apps
```

Expected: matches only under `packages/llm/llm-pi-ai` plus manifest/build
metadata; no Agent, tools, Session, config, or TUI source imports.

- [ ] **Step 2: Verify OpenAI wire fields do not remain in product contracts**

Run:

```bash
rg -n "reasoning_content|tool_call_id|tool_calls|role: [\"']tool[\"']" apps packages
```

Expected: no production-source output. Protocol fixture strings may exist only
under tests.

- [ ] **Step 3: Run the full build**

Run:

```bash
npm run build
```

Expected: exit 0 under Node.js `>=22.19.0`; TypeScript project references and
the esbuild bundle complete.

- [ ] **Step 4: Run the full keyless test suite**

Run:

```bash
npm test
```

Expected: exit 0; the real-provider test self-skips and no network call occurs.

- [ ] **Step 5: Run package and terminal acceptance checks**

Run:

```bash
npm run check:version
npm run smoke:package
npm run smoke:tui
```

Expected: all exit 0; package smoke resolves the pi-ai runtime dependency and
TUI smoke does not require credentials.

- [ ] **Step 6: Audit changed files and whitespace**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Expected: only planned source, test, manifest, lockfile, and documentation
changes are present; whitespace check is clean; no generated `dist/` or
`.build/` artifact is staged.

- [ ] **Step 7: Commit verification fixes if commits are authorized**

Stage only explicit files changed to fix verification failures, inspect the
staged diff, then commit:

```bash
git diff --cached --check
git commit -m "fix: complete pi-ai model migration"
```
