# Pi-AI Model Adaptation Design

## Status and scope

This document defines the complete replacement of LaoHuangCode's hand-written
OpenAI-compatible model bridge with a provider-neutral LaoHuang model contract
implemented by `@earendil-works/pi-ai`.

The design covers model-facing tool schemas, conversation messages, tool calls,
tool results, streaming events, replay metadata, provider/model lookup, CLI
composition, model switching, the semantic classifier, dependency removal,
packaging, and verification. It preserves the existing Agent loop, four built-in
tools, permissions, cancellation ownership, parallel/sequential tool execution,
Session scheduling, and TUI behavior.

This is one architectural change with one end state. The old
`@laohuang/llm-openai-compatible` implementation is removed after every caller
uses the new contract; the repository does not retain two production model
stacks.

## End-state product contract

LaoHuangCode owns one provider-neutral model vocabulary. Agent Runtime and Tool
Runtime never construct OpenAI, Anthropic, DeepSeek, or Pi wire messages. The
only package that imports `@earendil-works/pi-ai` is
`@laohuang/llm-pi-ai`.

The completed product must satisfy all of these properties:

1. The current OpenAI and DeepSeek profile workflows continue to work with API
   keys, model selection, optional `base_url`, `/model`, `/login`, and `/logout`.
2. Model-facing tool declarations use one LaoHuang `ToolSpec` containing
   `name`, `description`, and JSON Schema `parameters`.
3. Every native provider tool call becomes one LaoHuang `ToolCall` containing
   `id`, `name`, and raw JSON `arguments`.
4. Every tool execution outcome becomes one LaoHuang `ToolResultModelMessage`
   correlated by tool-call id and tool name before it is passed back to the
   model.
5. Provider-specific request bodies, stream fragments, reasoning fields,
   signatures, response ids, tool-result roles, and finish reasons are handled
   by pi-ai and the `llm-pi-ai` bridge, not by Agent Runtime.
6. A committed assistant message retains opaque adapter replay state needed for
   same-provider continuation. Switching provider/model keeps visible content
   and tool history while dropping replay state that is unsafe to reuse.
7. Cancellation reaches pi-ai through the existing `CancelToken.signal`.
8. A forced-final Agent request disables tools by omitting tools from the pi-ai
   `Context`; it does not depend on a provider-specific `tool_choice` field.
9. A response consisting of a textual DSML tool envelope is never executed as a
   tool call and is never presented as a successful final answer. It terminates
   as a typed protocol error with sanitized diagnostics.
10. The semantic classifier uses the same Model Runtime and pi-ai Adapter as
    Agent requests. No production code calls `client.chat.completions.create()`.
11. The public `laohuang` package no longer depends directly on the `openai`
    SDK. It depends on `@earendil-works/pi-ai@^0.83.0` and requires Node.js
    `>=22.19.0`.
12. Provider support is claimed only when configuration, authentication,
    request conversion, response conversion, and a real-provider contract test
    exist. Installing pi-ai does not by itself advertise every catalog provider
    as supported by the CLI.

An implementation that merely converts the current Chat Completions records
inside a new Adapter does not meet this contract: OpenAI wire fields would
remain the application's internal language and replay fidelity would remain
incomplete.

## Current architecture and failure mode

The package boundary exists, but the current supposedly neutral contract still
contains Chat Completions wire data:

- `ModelRequest.messages` and `ModelRequest.tools` are arrays of
  `Record<string, unknown>` documented as Chat Completions shapes;
- `StreamResult.messageDict()` writes `reasoning_content` and `tool_calls`;
- `ToolRegistry.definitions` writes `{ type: "function", function: ... }`;
- `CodingAgent.messages` stores Chat Completions records;
- `HistoryCommitter` writes `role: "tool"` plus `tool_call_id`;
- model switching strips provider-private fields with Chat-specific key logic;
- the semantic classifier directly calls the OpenAI SDK;
- CLI composition creates an OpenAI client before it creates the Adapter.

The DSML incident demonstrates the consequence. The current stream parser only
recognizes `choices[].delta.tool_calls`; a model that emits tool intent inside
ordinary text is committed as assistant text because the outbound provider
request and inbound stream translation are both tied to one protocol dialect.

## Architectural decisions

### LaoHuang owns the domain vocabulary

`@laohuang/llm` remains the interface consumed by Agent Runtime. It defines
typed messages, content blocks, finish reasons, usage, errors, replay envelopes,
stream events, model routes, and the `ModelAdapter`/`ModelRuntime` interfaces.

These are LaoHuang types, not aliases or re-exports of pi-ai types. This adds one
explicit conversion boundary but prevents a pi-ai upgrade from forcing changes
through Agent Runtime, Tool Runtime, Session, TUI, and tests.

### Pi-ai is the only provider-protocol implementation

`@laohuang/llm-pi-ai` converts LaoHuang requests into pi-ai `Context` values,
invokes a pi-ai `Models` collection, and converts pi-ai assistant events back to
LaoHuang events and results. It does not implement OpenAI SSE, DeepSeek thinking
fields, Anthropic tool-result roles, or provider HTTP clients itself.

The old OpenAI-compatible client, stream assembler, provider presets, and
Adapter registry are deleted.

### Product services remain outside the Adapter

The Adapter receives resolved values through interfaces. It does not read
`config.json`, read or write `credentials.json`, prompt in the terminal, commit
Session state, render retries, or execute tools.

`apps/cli` remains the composition root:

- `@laohuang/local-config` owns profile and API-key storage;
- CLI model selection owns interactive provider/model choice;
- Agent Runtime owns the model/tool loop and history commit points;
- Tool Runtime owns parsing, dispatch, cancellation, and concurrency;
- Session Runtime owns task lifecycle and safe points;
- TUI owns presentation.

### Current provider surface remains explicit

The application continues to expose `openai` and `deepseek` as supported
provider routes. `llm-pi-ai` resolves both from pi-ai's installed catalog and
may accept a request-level base URL override. The bridge is written against a
pi-ai `Models` collection and can serve another registered provider without a
new wire-protocol implementation, but the CLI must not list that provider until
its configuration, authentication, and real-provider verification are added.

OAuth flows, AWS/Vertex credential UX, and arbitrary self-hosted gateway
configuration are separate product capabilities. They are not silently claimed
by this model-adaptation change.

## Package and file structure

```text
packages/
├── core/
│   ├── agent-runtime/
│   │   └── src/
│   │       ├── agent.ts
│   │       └── core/
│   │           ├── agent-step-runner.ts
│   │           └── history-committer.ts
│   └── tools/
│       └── src/
│           ├── index.ts
│           └── tool-runtime.ts
└── llm/
    ├── llm/
    │   └── src/
    │       ├── index.ts
    │       ├── model-contracts.ts
    │       └── model-runtime.ts
    └── llm-pi-ai/
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── adapter.ts
            ├── context.ts
            ├── index.ts
            ├── replay.ts
            └── stream.ts
```

Responsibilities are fixed:

- `model-contracts.ts`: provider-neutral domain types and error taxonomy;
- `model-runtime.ts`: cancellation preflight, Adapter invocation, stale-request
  protection, and normalized failures;
- `context.ts`: LaoHuang request/history/tool-result to pi-ai `Context`;
- `replay.ts`: versioned opaque pi-ai continuation metadata;
- `stream.ts`: pi-ai assistant event to LaoHuang stream/result conversion;
- `adapter.ts`: model resolution, API-key injection, base-URL override,
  cancellation, invocation, and protocol-leak rejection;
- `index.ts`: the package's small public construction surface.

No `llm-pi-ai` file imports CLI, local-config, Agent Runtime, Session Runtime,
TUI, filesystem tools, or Bash tools.

## Provider-neutral interfaces

`@laohuang/tools` owns the reusable executable-tool vocabulary:

```ts
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly promptGuidelines: readonly string[];
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}
```

`ToolRegistry.definitions` becomes `readonly ToolSpec[]`. `promptGuidelines`
remains system-prompt-only; `llm-pi-ai` sends only `name`, `description`, and
`parameters` to pi-ai.

`@laohuang/llm` owns model history and completion types:

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
  readonly content: readonly AssistantContentBlock[];
  readonly provider: string;
  readonly model: string;
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
```

The request and result contracts are:

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

export type ModelFinishReason =
  | "stop"
  | "tool-calls"
  | "max-tokens";

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ModelResult {
  readonly requestId: string;
  readonly message: AssistantModelMessage;
  readonly finishReason: ModelFinishReason;
  readonly usage: ModelUsage;
}

export interface ModelAdapter {
  readonly name: string;
  runAttempt(request: ModelRequest): Promise<ModelResult>;
  listProviders(): readonly ModelProviderInfo[];
  listModels(provider: string): readonly ModelInfo[];
}
```

`ModelEvent` is a discriminated union for text, reasoning, tool-call argument
deltas, and response validation. Runtime-protocol keeps its current public
event names; `ModelRuntime` translates the typed events into those existing
event callbacks so TUI and Session projections do not depend on pi-ai.

`ModelErrorKind` gains `protocol` and retains `authentication`, `rate_limited`,
`context_overflow`, `server`, and `retryable`. Adapter errors never include API
keys, authorization headers, complete prompts, or raw tool results.

## Request conversion

For each request, `llm-pi-ai/context.ts` performs these operations:

1. Take the first system message as `Context.systemPrompt`. More than one system
   message is rejected as a protocol error rather than reordered.
2. Convert user messages to pi-ai user messages.
3. Convert assistant text, reasoning, and tool-call blocks to pi-ai assistant
   content. When a valid matching replay envelope exists, restore response ids
   and text/thinking/tool signatures.
4. Convert each `tool-result` message to pi-ai `role: "toolResult"`, preserving
   `toolCallId`, `toolName`, text content, and `isError`.
5. Convert each `ToolSpec` to pi-ai `Tool` using only `name`, `description`, and
   `parameters`.
6. When `toolChoice` is `none`, omit `Context.tools`. When it is `auto`, include
   the converted tools.

The Adapter resolves the requested provider/model from its pi-ai `Models`
collection. An unknown provider or model fails before any network request. A
`baseUrl` override is applied to an immutable request-local copy of the model;
the shared catalog is not mutated.

The Adapter obtains the API key through an injected function:

```ts
export interface PiAiAdapterOptions {
  readonly enabledProviders: readonly string[];
  readonly resolveApiKey: (
    provider: string,
  ) => string | null | Promise<string | null>;
}

export function createPiAiAdapter(options: PiAiAdapterOptions): ModelAdapter;
```

The callback can read LaoHuang's `CredentialStore`, but the Adapter never knows
where or how that store persists values.

## Response conversion and commit rules

`llm-pi-ai/stream.ts` consumes the complete pi-ai assistant-event lifecycle:

- `text_start/delta/end` becomes typed text events and one text block;
- `thinking_start/delta/end` becomes reasoning events and one reasoning block;
- `toolcall_start/delta/end` becomes tool-call argument delta events and one
  `ToolCall` with raw JSON arguments;
- terminal `done` maps usage and stop reason;
- terminal `error` maps to `ModelError` or `ModelStreamCancelled`;
- end-of-stream without `done` or `error` is a protocol error.

An attempt remains provisional until the terminal event validates all of these
invariants:

- `toolUse` contains at least one complete tool call;
- every tool call has a non-empty id and name;
- every tool call argument value serializes to a JSON object;
- `stop` produces at least one visible text block or another supported content
  block;
- usage fields are finite non-negative integers;
- the request is still active at commit time.

Only a validated `ModelResult.message` enters history. Tool execution begins
only from committed `tool-call` blocks.

## Replay state

Pi-ai response metadata required for continuation is stored under one opaque,
versioned LaoHuang envelope:

```ts
{
  adapter: "pi-ai",
  version: 1,
  state: {
    api,
    provider,
    model,
    responseModel,
    responseId,
    stopReason,
    blocks: [
      { type: "text", textSignature },
      { type: "reasoning", thinkingSignature, redacted },
      { type: "tool-call", thoughtSignature }
    ]
  }
}
```

The state is lossless JSON and index-aligned with committed assistant blocks.
Before replay, `llm-pi-ai` validates the version, provider/model identity, block
count, block types, and signature types. Invalid or foreign state degrades that
message to provider-neutral content and emits a sanitized diagnostic; it does
not discard the visible conversation or fail the whole request.

When `/model` switches provider or model, Agent Runtime applies
`portableModelMessage()` to history. The function preserves all visible
messages, call ids, tool names, arguments, results, and errors, but removes
assistant replay envelopes. New replies accumulate replay state for the new
route.

## Tool lifecycle after migration

The Agent loop remains structurally unchanged:

```text
ToolRegistry ToolSpec
        |
        v
LaoHuang ModelRequest
        |
        v
llm-pi-ai Context -> pi-ai -> provider
        |
        v
pi-ai ToolCall -> LaoHuang ToolCall
        |
        v
ToolRuntime execute
        |
        v
LaoHuang ToolResultModelMessage
        |
        v
llm-pi-ai toolResult -> pi-ai -> provider
```

`read`, `write`, `edit`, and `bash` keep their implementations. Their schemas
already live in `ToolSpec`; the registry stops wrapping those schemas in OpenAI
`function` objects. Existing permission, project-root confinement, output
limits, cancellation, event publication, and execution-mode behavior remain
authoritative.

## Textual DSML handling

Pi-ai normalizes native provider tool calls; it does not promise to parse a
provider's textual DSML envelope from assistant text. LaoHuang therefore treats
a completion as protocol leakage only when the complete trimmed visible output
matches the DSML tool-envelope structure: it starts with a DSML `tool_calls`
marker, contains at least one DSML `invoke` marker, and closes the envelope.

The response becomes `ModelError { kind: "protocol" }`. The diagnostic includes
provider, model, request id, and the fact that textual tool protocol leaked, but
not the raw arguments or full model output. LaoHuang does not execute, repair,
or silently retry the textual call. Ordinary prose that merely mentions the
string `DSML` does not match this rule.

## CLI composition and semantic classifier

`apps/cli` creates one long-lived pi-ai Adapter and one Model Runtime. The
Adapter's API-key resolver closes over the existing `CredentialStore`; changing
a key immediately affects the next request without rebuilding an SDK client.

`ModelSelector` returns only resolved product configuration:

```ts
export interface ModelSelection {
  readonly config: SelectionConfig;
}
```

It obtains provider/model choices from the neutral Adapter catalog and does not
construct a provider SDK client. `CodingAgent.switchModel()` receives provider,
model, and base URL, clears unsafe replay state, and reuses the same Adapter.

`SmallModelSemanticClassifier` receives a `ModelRuntime` plus the current route.
It performs a no-tools, temperature-zero request through the same Adapter and
retains its existing timeout, strict JSON parsing, confidence threshold, and
fail-closed behavior. Pi-ai's common request does not guarantee OpenAI
`response_format`; the classifier relies on its JSON-only system prompt and
rejects malformed output.

## Cancellation, errors, and retries

The existing `CancelToken.signal` is passed directly to pi-ai. Cancellation
before request creation fails immediately. Cancellation during streaming stops
the provider stream, prevents history commit, and surfaces
`ModelStreamCancelled` without being reclassified as a provider failure.

The Adapter maps pi-ai terminal failures into the stable LaoHuang taxonomy. A
failure after streamed deltas records `hadDelta: true` so retry policy can avoid
duplicating visible output. This design does not add a new retry owner; current
Agent/Session behavior remains authoritative. Pi-ai SDK retry configuration is
set to one attempt when the API exposes that option, so future LaoHuang retries
can remain observable and task-scoped.

## Dependency, runtime, and packaging contract

The dependency changes are:

- add private workspace `@laohuang/llm-pi-ai`;
- add `@earendil-works/pi-ai@^0.83.0` as the public CLI runtime dependency;
- remove direct `openai@^6.49.0` dependency;
- remove workspace `@laohuang/llm-openai-compatible`;
- update root and CLI engines to Node.js `>=22.19.0`;
- update esbuild target to `node22.19`;
- externalize `@earendil-works/pi-ai` and its subpaths from the single-file CLI
  bundle;
- update TypeScript project references and the lockfile.

Internal `@laohuang/*` packages remain bundled. The published npm artifact
remains the single `laohuang` CLI package.

## Testing strategy

### Provider-neutral contract tests

Tests prove typed messages, portable history, tool schemas, tool-result
correlation, usage validation, finish reasons, cancellation, stale requests,
and error classification without importing pi-ai.

### Pi bridge fixture tests

Fake pi-ai event streams cover:

- text and reasoning deltas;
- fragmented and parallel tool calls;
- tool-result request conversion;
- same-provider replay signatures and response ids;
- provider/model switch replay degradation;
- usage and finish mapping;
- terminal error and aborted events;
- stream termination without a terminal event;
- DSML-like text that must fail as protocol leakage;
- ordinary text mentioning DSML that must remain text;
- request cancellation before and during streaming.

### Agent integration tests

Agent tests assert the two-request tool loop using typed history:

1. model returns one or multiple ToolCalls;
2. ToolRuntime executes with existing serial/parallel policy;
3. history receives assistant and correlated tool-result messages;
4. the next model request contains those results;
5. final text returns unchanged;
6. forced-final requests omit tools;
7. `/model` preserves portable history and drops replay state.

### Keyless product tests

CLI tests use fake ModelAdapters and verify initial setup, configured startup,
`/model`, `/login`, `/logout`, semantic classification, missing credentials,
unknown models, and provider errors without network calls.

### Optional real-provider contract tests

A DeepSeek test self-skips unless `DEEPSEEK_API_KEY` is present. It sends a
fixed tool schema, asserts a native ToolCall is returned, sends a correlated
ToolResult, and asserts the model continues without textual DSML. This test is
not run automatically with a real key and is never used as a substitute for
keyless unit/integration coverage.

## Documentation changes

The implementation updates:

- `README.md` and `apps/cli/README.md` to describe pi-ai-backed model access;
- `docs/architecture.md` and the workspace architecture spec to replace the
  obsolete package/dependency graph;
- `docs/configuration.md` to remove client-rebuild language and document model
  switching with portable history;
- `docs/security.md` to record the unchanged credential ownership and sanitized
  protocol diagnostics;
- `docs/npm-distribution.md` and `docs/publishing.md` for Node.js `>=22.19.0`
  and the pi-ai runtime dependency.

Historical implementation plans remain unchanged as records of earlier work.

## Acceptance criteria

The change is complete only when:

1. `rg "llm-openai-compatible|chat\.completions|reasoning_content|tool_call_id|tool_calls" apps packages` finds no production OpenAI wire dependency outside
   intentionally named protocol-fixture strings in `llm-pi-ai` tests.
2. `packages/llm/llm-openai-compatible` no longer exists.
3. Agent Runtime, Tool Runtime, Session Runtime, and TUI import no pi-ai types.
4. `read`, `write`, `edit`, and `bash` pass their existing behavior tests.
5. Native ToolCall and ToolResult continuation pass pi-ai bridge tests.
6. Textual DSML is rejected as a protocol error and never dispatched.
7. Model switching preserves portable visible history and removes incompatible
   replay state.
8. The semantic classifier contains no direct provider SDK call.
9. `npm run build` and `npm test` pass.
10. `npm run check:version`, `npm run smoke:package`, and `npm run smoke:tui`
    pass without real provider calls.
11. The package smoke test proves the installed CLI resolves pi-ai from its
    declared runtime dependencies on Node.js `>=22.19.0`.
