# Workspace Package Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert laoHuangCode into an acyclic DSH-style `apps/*` plus `packages/<domain>/<package>` npm workspace while preserving the single published `laohuang` CLI and all current behavior.

**Architecture:** The private root orchestrates TypeScript project references. Provider-neutral runtime and tool protocols point inward; concrete OpenAI-compatible, filesystem, Bash, configuration, and TUI implementations point outward; `apps/cli` is the only composition root. The CLI build bundles all private workspaces into one Node.js 18 ESM executable and leaves only `openai` external.

**Tech Stack:** TypeScript 5.5+, Node.js 18+ runtime, npm workspaces, TypeScript project references, Node test runner, esbuild, official `openai` SDK.

**Spec:** `docs/superpowers/specs/2026-08-25-workspace-package-architecture-design.md`

## Global Constraints

- The current TUI/core/Web-deletion worktree state must be committed as a separate checkpoint before execution; create the execution worktree from that checkpoint with `superpowers:using-git-worktrees`.
- The final root package is private and uses exactly `apps/*` and `packages/*/*` as workspace globs.
- The final repository has no production root `src/` directory.
- `apps/cli` is the only application and `laohuang` remains the only published npm package and command.
- Every internal package is private, has version `0.0.0`, owns `src/index.ts`, and exposes only `dist/index.js` and `dist/index.d.ts`.
- Cross-package imports use `@laohuang/*` package names; relative imports never cross a package root and consumers never deep-import another package's `src/` or `dist/`.
- The internal package dependency graph is acyclic; packages never depend on `apps/cli`.
- Session consumes an `AgentRunner` contract and never imports `CodingAgent` or CLI commands.
- Agent consumes `ModelAdapter` and `ToolRegistry` contracts and never imports the OpenAI SDK or concrete filesystem/Bash tools.
- The TUI consumes runtime events and structural completion data and never imports CLI command implementations.
- Preserve all existing CLI, plain-mode, TUI, model-stream, tool, routing, queue, cancellation, event, configuration, and project-instruction behavior.
- Keep tests and repository engineering automation under `scripts/`.
- Do not add runtime dependencies other than the existing `openai@^6.49.0`; `esbuild` is the only new development dependency.
- Do not run provider calls or tests requiring real API keys.
- Use `apply_patch` for content edits and explicit `git mv` commands only for file moves.
- Stage explicit paths only. Commit steps in this plan require the user's explicit commit authorization when execution begins.

## Locked file structure

| Workspace path | Package name | Direct internal dependencies |
| --- | --- | --- |
| `packages/core/runtime-protocol` | `@laohuang/runtime-protocol` | none |
| `packages/core/tools` | `@laohuang/tools` | `@laohuang/runtime-protocol` |
| `packages/llm/llm` | `@laohuang/llm` | `@laohuang/runtime-protocol`, `@laohuang/tools` |
| `packages/llm/llm-openai-compatible` | `@laohuang/llm-openai-compatible` | `@laohuang/llm`, `@laohuang/runtime-protocol`, `@laohuang/tools` |
| `packages/fs/tool-fs` | `@laohuang/tool-fs` | `@laohuang/runtime-protocol`, `@laohuang/tools` |
| `packages/shell/bash-local` | `@laohuang/bash-local` | `@laohuang/runtime-protocol` |
| `packages/shell/tool-bash` | `@laohuang/tool-bash` | `@laohuang/bash-local`, `@laohuang/runtime-protocol`, `@laohuang/tools` |
| `packages/context/project-instructions` | `@laohuang/project-instructions` | none |
| `packages/storage/local-config` | `@laohuang/local-config` | none |
| `packages/core/agent-runtime` | `@laohuang/agent-runtime` | runtime protocol, tools, llm, project instructions |
| `packages/core/session-runtime` | `@laohuang/session-runtime` | runtime protocol |
| `packages/terminal/tui` | `@laohuang/tui` | runtime protocol |
| `apps/cli` | `laohuang` | all concrete packages as development inputs; only `openai` at published runtime |

Every internal `package.json` uses the fixed metadata below plus the exact
package name and dependency row from the table above. This is the complete
manifest for `packages/core/runtime-protocol/package.json`:

```json
{
  "name": "@laohuang/runtime-protocol",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"]
}
```

Use exact internal dependency versions of `0.0.0`. Each package
`tsconfig.json` extends `../../../tsconfig.base.json`, sets
`rootDir: "src"`, `outDir: "dist"`, and `composite: true`, includes `src`,
and lists project references matching the dependency table.

---

### Task 1: Remove reverse dependencies before moving files

**Files:**
- Create: `src/core/runtime-protocol.ts`
- Create: `src/tui/contracts.ts`
- Modify: `src/agent.ts`
- Modify: `src/session.ts`
- Modify: `src/commands.ts`
- Modify: `src/client.ts`
- Modify: `src/core/human-intent-router.ts`
- Modify: `src/tui/ui.ts`
- Modify: `src/tui/frame-builder.ts`
- Modify: `src/tui/components/completion-list.ts`
- Modify: `src/tui/terminal-input-decoder.ts`
- Test: `scripts/runtime-contracts.test.ts`
- Test: `scripts/commands.test.ts`
- Test: `scripts/client.test.ts`
- Test: `scripts/frame-builder.test.ts`
- Test: `scripts/tui-ui.test.ts`

**Interfaces:**
- Consumes: Existing `CancelToken`, `EventBus`, `EventKind`, `AgentEventPublishOptions`, `PendingInputBatchLike`, CLI command results, queue status, and TUI editor completion behavior.
- Produces: `AgentRuntimeContext`, `AgentRunner`, `CommandResult`, `QueueStatus`, and private TUI `EditorLike`, `CompletionItemLike`, and `InputDecoderLike` interfaces with no concrete-module reverse imports.

- [ ] **Step 1: Write compile-time contract assertions before creating the contracts**

Add these imports and assertions to `scripts/runtime-contracts.test.ts`:

```ts
import type {
  AgentRunner,
  CommandResult,
  QueueStatus,
} from "../src/core/runtime-protocol.ts";

type ExpectedCommandResult =
  | { readonly status: "handled" }
  | { readonly status: "not_found"; readonly command: string }
  | { readonly status: "blocked"; readonly command: string }
  | { readonly status: "exit_requested" }
  | { readonly status: "error"; readonly error: unknown };

const commandResultContract: CommandResult extends ExpectedCommandResult
  ? true
  : never = true;
const queueStatusContract: QueueStatus = {
  pending: 1,
  pendingTokens: 2,
  held: 3,
  heldTokens: 4,
  deadLetters: 5,
};
const runnerContract: AgentRunner | null = null;
void commandResultContract;
void queueStatusContract;
void runnerContract;
```

- [ ] **Step 2: Run the build and verify the missing protocol fails**

Run: `npm run build`

Expected: FAIL because `src/core/runtime-protocol.ts` does not exist.

- [ ] **Step 3: Add the protocol and switch Session and commands to it**

Create `src/core/runtime-protocol.ts` with the exact public unions and
interfaces from the spec. Preserve the existing optional Agent context hooks:

```ts
export type CommandResult =
  | { readonly status: "handled" }
  | { readonly status: "not_found"; readonly command: string }
  | { readonly status: "blocked"; readonly command: string }
  | { readonly status: "exit_requested" }
  | { readonly status: "error"; readonly error: unknown };

export interface QueueStatus {
  readonly pending: number;
  readonly pendingTokens: number;
  readonly held: number;
  readonly heldTokens: number;
  readonly deadLetters: number;
}

export interface AgentRuntimeContext {
  readonly sessionId?: string | null;
  readonly taskId?: string | null;
  readonly cancelToken?: CancelToken | null;
  readonly eventBus?: EventBus | null;
  publish?(kind: EventKind, options: AgentEventPublishOptions): unknown;
  modelStarted?(): boolean | void;
  modelRequestOpened?(): boolean | void;
  toolsStarted?(): void;
  safePoint?(): PendingInputBatchLike | null | undefined;
  commitInput?(append: () => void, rollback: () => void): boolean;
  commitPending?(
    batch: PendingInputBatchLike,
    append: () => void,
    rollback: () => void,
  ): boolean;
  commitIfActive?(callback: () => void): boolean;
}

export type AgentRunnerResult = string | null | Promise<string | null>;

export interface AgentRunner {
  run(input: string, context: AgentRuntimeContext | null): AgentRunnerResult;
}
```

Update `CodingAgent.run` to accept `AgentRuntimeContext | null`. Make
`TaskContext` implement `AgentRuntimeContext`. Delete the concrete
`CodingAgent` type import and compile-time assertion from `session.ts`.
Import `CommandResult` and `QueueStatus` from the protocol in both Session and
commands. Keep command-only structural views inside `commands.ts`.

- [ ] **Step 4: Move command tokenization into Session ownership**

Move `shlexSplit` from `commands.ts` to
`src/core/human-intent-router.ts`, rename it `splitHumanCommand`, and keep it
exported for focused tests. `commands.ts` gets a private `splitCommandArgs`
with the same existing POSIX quoting behavior for slash-command dispatch.
This removes Session runtime's dependency on the CLI command module without
changing either caller's parsing rules.

- [ ] **Step 5: Move private TUI contracts out of `ui.ts`**

Create `src/tui/contracts.ts`:

```ts
export interface CompletionItemLike {
  readonly value: string;
  readonly description: string;
  readonly start: number;
}

export interface EditorLike {
  readonly text: string;
  readonly cursor: number;
  readonly displayLines: readonly string[];
}

export interface InputDecoderLike {
  feed(chunk: Buffer): void;
  flushEscapeTimeout(): void;
  reset(): void;
}
```

Move the complete existing `EditorLike` and `InputDecoderLike` members from
`ui.ts` into this file rather than dropping any methods. Import the contracts
from `contracts.ts` in `ui.ts`, `frame-builder.ts`,
`components/completion-list.ts`, and `terminal-input-decoder.ts`. Commands own
their `CompletionItem` shape and must not import `tui/editor.ts`.

- [ ] **Step 6: Remove configuration from the model client interface**

Delete the `Config` import, `AssertConfigAssignable`, and assertion value from
`client.ts`. Preserve this self-contained interface:

```ts
export interface ClientConfig {
  apiKey?: string | null | undefined;
  baseUrl?: string | null | undefined;
}
```

The CLI continues passing the structurally compatible resolved configuration.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test scripts/runtime-contracts.test.ts scripts/session.test.ts scripts/commands.test.ts scripts/client.test.ts scripts/frame-builder.test.ts scripts/tui-ui.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run repository verification**

Run:

```bash
npm run build
npm test
git diff --check
```

Expected: build succeeds, all tests pass, and diff check prints nothing.

- [ ] **Step 9: Commit the dependency corrections**

```bash
git add src/core/runtime-protocol.ts src/tui/contracts.ts src/agent.ts src/session.ts src/commands.ts src/client.ts src/core/human-intent-router.ts src/tui/ui.ts src/tui/frame-builder.ts src/tui/components/completion-list.ts src/tui/terminal-input-decoder.ts scripts/runtime-contracts.test.ts scripts/commands.test.ts scripts/client.test.ts scripts/frame-builder.test.ts scripts/tui-ui.test.ts
git commit -m "refactor: define package-ready runtime contracts"
```

### Task 2: Create the workspace root and runtime-protocol package

**Files:**
- Create: `tsconfig.base.json`
- Create: `tsconfig.legacy.json`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `packages/core/runtime-protocol/package.json`
- Create: `packages/core/runtime-protocol/tsconfig.json`
- Create: `packages/core/runtime-protocol/src/index.ts`
- Move: runtime protocol, cancellation, events, actions, intents, runtime events, and queue bridge into `packages/core/runtime-protocol/src/`
- Modify: all current source and focused test imports of the moved modules
- Test: `scripts/runtime-contracts.test.ts`
- Test: `scripts/events.test.ts`
- Test: `scripts/cancellation.test.ts`
- Test: `scripts/session-action.test.ts`

**Interfaces:**
- Consumes: Task 1's contract definitions and current strict TypeScript settings.
- Produces: Buildable `@laohuang/runtime-protocol` and a temporary `tsconfig.legacy.json` that compiles remaining root `src/` during the migration.

- [ ] **Step 1: Point focused tests at the future package entrypoint**

Change the affected test imports to:

```ts
import {
  CancelToken,
  EventBus,
  EventKind,
  type AgentRunner,
  type CommandResult,
  type QueueStatus,
} from "../packages/core/runtime-protocol/src/index.ts";
```

Keep test assertions unchanged.

- [ ] **Step 2: Run the focused tests and verify the missing package fails**

Run:

```bash
node --test scripts/runtime-contracts.test.ts scripts/events.test.ts scripts/cancellation.test.ts scripts/session-action.test.ts
```

Expected: FAIL because the package source entrypoint does not exist.

- [ ] **Step 3: Convert root metadata to workspace orchestration**

Change root `package.json` to use these fields while retaining the existing
repository scripts and development dependencies:

```json
{
  "name": "@laohuang/workspace",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*/*"],
  "scripts": {
    "build": "tsc -b",
    "test": "node --test \"scripts/**/*.test.ts\""
  }
}
```

Keep the root version and publishing fields only until Task 9 moves them into
`apps/cli`; the private flag prevents accidental root publication during the
migration.

Create `tsconfig.base.json` by moving the current compiler options there and
removing `rootDir` and `outDir`. Add `composite: true`.

Create `tsconfig.legacy.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "references": [
    { "path": "./packages/core/runtime-protocol" }
  ]
}
```

Replace root `tsconfig.json` with project references to runtime protocol first
and legacy second.

- [ ] **Step 4: Create and populate runtime protocol**

Create the internal manifest from the locked table and a package tsconfig
with no project references. Move these files explicitly:

```bash
mkdir -p packages/core/runtime-protocol/src
git mv src/cancellation.ts packages/core/runtime-protocol/src/cancellation.ts
git mv src/events.ts packages/core/runtime-protocol/src/events.ts
git mv src/core/runtime-protocol.ts packages/core/runtime-protocol/src/runtime-protocol.ts
git mv src/core/runtime-events.ts packages/core/runtime-protocol/src/runtime-events.ts
git mv src/core/session-action.ts packages/core/runtime-protocol/src/session-action.ts
git mv src/core/session-action-protocol.ts packages/core/runtime-protocol/src/session-action-protocol.ts
git mv src/core/user-intent.ts packages/core/runtime-protocol/src/user-intent.ts
git mv src/core/queue-bridge.ts packages/core/runtime-protocol/src/queue-bridge.ts
```

Create `src/index.ts` with explicit exports:

```ts
export * from "./cancellation.ts";
export * from "./events.ts";
export * from "./queue-bridge.ts";
export * from "./runtime-events.ts";
export * from "./runtime-protocol.ts";
export * from "./session-action.ts";
export * from "./session-action-protocol.ts";
export * from "./user-intent.ts";
```

Update remaining source imports to `@laohuang/runtime-protocol`. Imports
between files inside the package remain relative.

- [ ] **Step 5: Refresh workspace metadata safely**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
```

Expected: lockfile records the workspace and `node_modules/@laohuang/runtime-protocol`
resolves to the local package.

- [ ] **Step 6: Build and run focused tests**

Run:

```bash
npm run build
node --test scripts/runtime-contracts.test.ts scripts/events.test.ts scripts/cancellation.test.ts scripts/session-action.test.ts
npm test
```

Expected: all commands pass.

- [ ] **Step 7: Commit workspace root and protocol package**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.base.json tsconfig.legacy.json packages/core/runtime-protocol scripts/runtime-contracts.test.ts scripts/events.test.ts scripts/cancellation.test.ts scripts/session-action.test.ts
git add src/agent.ts src/cli.ts src/commands.ts src/model-adapter.ts src/model-stream.ts src/routing.ts src/session.ts
git add src/core/agent-step-runner.ts src/core/agent-turn-loop.ts src/core/guard-policy.ts src/core/history-committer.ts src/core/human-intent-router.ts src/core/model-runtime.ts src/core/queue-dispatcher.ts src/core/task-lifecycle.ts src/core/tool-runtime.ts
git add src/tui/display-policy.ts
git commit -m "refactor: establish runtime protocol workspace"
```

### Task 3: Extract tool protocol and built-in tool Adapters

**Files:**
- Create: `packages/core/tools/**`
- Create: `packages/fs/tool-fs/**`
- Create: `packages/shell/bash-local/**`
- Create: `packages/shell/tool-bash/**`
- Remove after extraction: `src/tools.ts`
- Move: `src/bash-runner.ts`
- Move and refactor: `src/core/tool-runtime.ts`
- Modify: `src/agent.ts`
- Modify: `src/core/agent-step-runner.ts`
- Modify: `src/system-prompt.ts`
- Modify: root and legacy tsconfig references
- Modify: affected test imports
- Test: `scripts/tools.test.ts`
- Test: `scripts/bash-runner.test.ts`
- Test: `scripts/tool-runtime.test.ts`
- Test: `scripts/system-prompt.test.ts`

**Interfaces:**
- Consumes: `CancelToken` and event protocol from `@laohuang/runtime-protocol`.
- Produces: Provider-independent `ToolSpec`, `ToolCall`, `ToolResult`, `ToolDefinition`, `ToolExecutionContext`, and `ToolRegistry`; `createFileToolDefinitions()`; `runBash()`; `createBashToolDefinition()`.

- [ ] **Step 1: Point tool tests at the future public entries**

Use these source entrypoints in focused tests:

```ts
import { ToolRegistry } from "../packages/core/tools/src/index.ts";
import { createFileToolDefinitions } from "../packages/fs/tool-fs/src/index.ts";
import { runBash } from "../packages/shell/bash-local/src/index.ts";
import { createBashToolDefinition } from "../packages/shell/tool-bash/src/index.ts";
```

Add one registry composition assertion:

```ts
const registry = new ToolRegistry([
  ...createFileToolDefinitions({ projectRoot }),
  createBashToolDefinition(),
]);
assert.deepEqual(
  registry.definitions().map((definition) => definition.name),
  ["read", "write", "edit", "bash"],
);
```

- [ ] **Step 2: Run tool tests and verify missing packages fail**

Run:

```bash
node --test scripts/tools.test.ts scripts/bash-runner.test.ts scripts/tool-runtime.test.ts scripts/system-prompt.test.ts
```

Expected: FAIL on missing package entrypoints.

- [ ] **Step 3: Create the four package manifests and project references**

Create manifests using the locked metadata and these exact dependencies:

```json
{
  "@laohuang/tools": ["@laohuang/runtime-protocol"],
  "@laohuang/tool-fs": ["@laohuang/runtime-protocol", "@laohuang/tools"],
  "@laohuang/bash-local": ["@laohuang/runtime-protocol"],
  "@laohuang/tool-bash": ["@laohuang/bash-local", "@laohuang/runtime-protocol", "@laohuang/tools"]
}
```

Add their paths to root `tsconfig.json` before the legacy reference and add
matching references to `tsconfig.legacy.json`.

- [ ] **Step 4: Extract the tool protocol and registry**

Create `packages/core/tools/src/types.ts` with the existing tool schema and
result fields plus these implementation contracts:

```ts
export interface ToolExecutionContext {
  readonly projectRoot: string;
  readonly cancelToken: CancelToken | null;
  readonly onOutput?: (
    stream: "stdout" | "stderr",
    text: string,
  ) => void;
}

export interface ToolDefinition {
  readonly spec: ToolSpec;
  readonly executionMode: "parallel" | "sequential";
  execute(
    argumentsValue: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}
```

Move registry lookup, definition serialization, touched-path metadata, batch
execution-mode rules, and the refactored `ToolRuntime` into this package.
`ToolRegistry` receives definitions in its constructor and contains no Node
filesystem or Bash imports.

- [ ] **Step 5: Extract filesystem and Bash implementations**

Move `bash-runner.ts` unchanged into
`packages/shell/bash-local/src/bash-runner.ts`, correcting only imports to the
runtime protocol. Extract existing read/write/edit specifications, argument
validation, root confinement, file IO, and path locking from `tools.ts` into
`packages/fs/tool-fs/src/file-tools.ts` and export:

```ts
export interface FileToolOptions {
  readonly projectRoot: string;
  readonly fileIo?: ToolFileIo;
}

export function createFileToolDefinitions(
  options: FileToolOptions,
): readonly ToolDefinition[];
```

Extract the Bash schema and registry Adapter into
`packages/shell/tool-bash/src/tool-bash.ts` and export:

```ts
export interface BashToolOptions {
  readonly run?: RunBash;
}

export function createBashToolDefinition(
  options?: BashToolOptions,
): ToolDefinition;
```

Do not change schemas, descriptions, prompt guidance, cancellation, output
limits, or filesystem safety behavior during extraction.

- [ ] **Step 6: Add package public entries and compose tools in the caller**

Each `src/index.ts` explicitly exports only its package-owned contracts and
implementations. Replace `new ToolRegistry(projectRoot)` with:

```ts
new ToolRegistry([
  ...createFileToolDefinitions({ projectRoot }),
  createBashToolDefinition(),
]);
```

Update Agent and system-prompt imports to `@laohuang/tools`.

- [ ] **Step 7: Build and verify tool behavior**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run build
node --test scripts/tools.test.ts scripts/bash-runner.test.ts scripts/tool-runtime.test.ts scripts/system-prompt.test.ts
npm test
```

Expected: all tests pass and the four built-in definitions remain ordered
`read`, `write`, `edit`, `bash`.

- [ ] **Step 8: Commit tool packages**

Stage the four package directories, exact Agent/system-prompt/test import
changes, root build metadata, and deletion of `src/tools.ts` explicitly:

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json
git add packages/core/tools packages/fs/tool-fs packages/shell/bash-local packages/shell/tool-bash
git add src/agent.ts src/system-prompt.ts src/tools.ts src/bash-runner.ts src/core/agent-step-runner.ts src/core/guard-policy.ts src/core/history-committer.ts src/core/tool-runtime.ts
git add scripts/tools.test.ts scripts/bash-runner.test.ts scripts/tool-runtime.test.ts scripts/system-prompt.test.ts scripts/agent.test.ts scripts/agent-step-runner.test.ts
git commit -m "refactor: package built-in tool adapters"
```

### Task 4: Extract model protocol and OpenAI-compatible Adapter

**Files:**
- Create: `packages/llm/llm/**`
- Create: `packages/llm/llm-openai-compatible/**`
- Move and split: `src/model-adapter.ts`
- Move and split: `src/model-stream.ts`
- Move: `src/client.ts`
- Move: `src/providers.ts`
- Move: `src/core/model-runtime.ts`
- Modify: current Agent, CLI, config, model-selection, and semantic-classifier imports
- Modify: root and legacy tsconfig references
- Test: `scripts/model-adapter.test.ts`
- Test: `scripts/model-stream.test.ts`
- Test: `scripts/model-runtime.test.ts`
- Test: `scripts/client.test.ts`
- Test: `scripts/providers.test.ts`

**Interfaces:**
- Consumes: runtime cancellation/events and tool schema/call contracts.
- Produces: `ModelAdapter`, `ModelRequest`, `ModelAttempt`, model events/errors/usage, `OpenAICompatibleAdapter`, `AdapterRegistry`, `createClient`, `getProvider`, and `providerNames`.

- [ ] **Step 1: Update model tests to target the future package entries**

Use:

```ts
import type { ModelAdapter, ModelRequest } from "../packages/llm/llm/src/index.ts";
import {
  AdapterRegistry,
  OpenAICompatibleAdapter,
  createClient,
  getProvider,
  providerNames,
} from "../packages/llm/llm-openai-compatible/src/index.ts";
```

Rename test references to the current `OpenAIAdapter` and `DeepSeekAdapter`
to one `OpenAICompatibleAdapter` configured with provider capabilities. Keep
the two provider-preset assertions.

- [ ] **Step 2: Run model tests and verify missing packages fail**

Run:

```bash
node --test scripts/model-adapter.test.ts scripts/model-stream.test.ts scripts/model-runtime.test.ts scripts/client.test.ts scripts/providers.test.ts
```

Expected: FAIL on missing package entrypoints.

- [ ] **Step 3: Create model package metadata**

Create both manifests from the locked table. `@laohuang/llm` depends on
runtime protocol and tools. `@laohuang/llm-openai-compatible` depends on llm,
runtime protocol, tools, and `openai@^6.49.0`. Add matching project references
to root and legacy tsconfigs.

- [ ] **Step 4: Extract provider-neutral model contracts**

Move provider-neutral message, request, event, attempt, error, usage, and tool
call shapes into `packages/llm/llm/src/`. The public Adapter is:

```ts
export interface ModelAdapter {
  runAttempt(request: ModelRequest): Promise<ModelAttempt>;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolSpec[];
  readonly cancelToken: CancelToken | null;
  readonly toolChoice?: "auto" | "none";
  readonly onEvent: (event: ModelEvent) => void;
}
```

Preserve portable history conversion and model error categories as
provider-neutral exports only when Agent runtime consumes them.

- [ ] **Step 5: Move OpenAI-compatible implementation behind the Adapter**

Move SDK client creation, Chat Completions stream accumulation, request
translation, DeepSeek reasoning handling, provider capabilities, presets, and
error translation into `@laohuang/llm-openai-compatible`. Replace the two
classes with one concrete class whose constructor accepts capabilities:

```ts
export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(options: {
    readonly provider: string;
    readonly capabilities: ModelCapabilities;
  });
  runAttempt(request: ModelRequest): Promise<ModelAttempt>;
}
```

`AdapterRegistry` maps both `openai` and `deepseek` to concrete instances.
Behavior and test fixtures remain unchanged.

- [ ] **Step 6: Build and run model tests**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run build
node --test scripts/model-adapter.test.ts scripts/model-stream.test.ts scripts/model-runtime.test.ts scripts/client.test.ts scripts/providers.test.ts
npm test
```

Expected: all tests pass with no real provider calls.

- [ ] **Step 7: Commit model packages**

Stage the two package directories, exact moved-file deletions, imports, tests,
tsconfigs, and lockfile; then commit:

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json
git add packages/llm/llm packages/llm/llm-openai-compatible
git add src/agent.ts src/cli.ts src/config.ts src/model-adapter.ts src/model-selection.ts src/model-stream.ts src/providers.ts src/semantic-classifier.ts src/core/agent-step-runner.ts src/core/model-runtime.ts
git add scripts/model-adapter.test.ts scripts/model-stream.test.ts scripts/model-runtime.test.ts scripts/client.test.ts scripts/providers.test.ts scripts/agent.test.ts scripts/semantic-classifier.test.ts
git commit -m "refactor: package model adapter boundary"
```

### Task 5: Extract project instructions and local configuration

**Files:**
- Create: `packages/context/project-instructions/**`
- Create: `packages/storage/local-config/**`
- Move: `src/project-instructions.ts`
- Move: `src/config.ts`
- Move: `src/credentials.ts`
- Modify: current CLI, Agent, and model-selection imports
- Modify: root and legacy tsconfig references
- Test: `scripts/project-instructions.test.ts`
- Test: `scripts/config.test.ts`
- Test: `scripts/credentials.test.ts`

**Interfaces:**
- Consumes: Node filesystem only.
- Produces: project-instruction discovery/rendering and provider-agnostic local profile/credential persistence.

- [ ] **Step 1: Update focused tests to new package entries**

Use:

```ts
import {
  discoverInstructions,
  findProjectRoot,
  loadBaselineInstructions,
} from "../packages/context/project-instructions/src/index.ts";
import {
  ConfigManager,
  CredentialStore,
  defaultConfigPath,
} from "../packages/storage/local-config/src/index.ts";
```

- [ ] **Step 2: Run focused tests and verify missing packages fail**

Run:

```bash
node --test scripts/project-instructions.test.ts scripts/config.test.ts scripts/credentials.test.ts
```

Expected: FAIL on missing entries.

- [ ] **Step 3: Create and populate project-instructions**

Create the private manifest and tsconfig with no internal dependencies. Move
`project-instructions.ts` and export all current public names through
`src/index.ts`. Do not change the instruction filenames, size budgets,
hierarchical recognition, rendering, or realpath behavior.

- [ ] **Step 4: Make configuration provider-agnostic and move it**

Remove `getProvider` imports from configuration and credentials. Change
`ConfigureOptions` so the app supplies fully resolved values:

```ts
export interface ConfigureOptions {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string | null;
}
```

`ConfigManager.configure` persists exactly those values. `resolveSettings`
returns stored strings without validating a provider catalog. `apps/cli`
performs `getProvider(config.provider)` after resolution and before client
construction. Move config and credentials into `local-config` and export their
current public types/classes.

- [ ] **Step 5: Build and verify persistence behavior**

Run:

```bash
npm run build
node --test scripts/project-instructions.test.ts scripts/config.test.ts scripts/credentials.test.ts scripts/cli.test.ts
npm test
```

Expected: permissions, atomic writes, environment precedence, instruction
budgets, and hierarchical loading tests pass.

- [ ] **Step 6: Commit context and configuration packages**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json
git add packages/context/project-instructions packages/storage/local-config
git add src/agent.ts src/cli.ts src/config.ts src/credentials.ts src/model-selection.ts src/project-instructions.ts
git add scripts/project-instructions.test.ts scripts/config.test.ts scripts/credentials.test.ts scripts/cli.test.ts scripts/model-selection.test.ts
git commit -m "refactor: package local context and configuration"
```

### Task 6: Move Agent runtime behind protocol interfaces

**Files:**
- Create: `packages/core/agent-runtime/package.json`
- Create: `packages/core/agent-runtime/tsconfig.json`
- Create: `packages/core/agent-runtime/src/index.ts`
- Move: `src/agent.ts`
- Move: `src/core/agent-step-runner.ts`
- Move: `src/core/guard-policy.ts`
- Move: `src/core/history-committer.ts`
- Move: `src/system-prompt.ts`
- Modify: current CLI, Session, and command imports
- Modify: root and legacy tsconfig references
- Test: `scripts/agent.test.ts`
- Test: `scripts/agent-step-runner.test.ts`
- Test: `scripts/system-prompt.test.ts`

**Interfaces:**
- Consumes: `AgentRuntimeContext`, `ModelAdapter`, `ToolRegistry`, and project-instruction exports.
- Produces: `CodingAgent`, `AgentError`, `AgentCancelled`, `RunOptions`, and `FORCED_FINAL_PROMPT` without a concrete provider or tool implementation dependency.

- [ ] **Step 1: Point Agent tests at the future package entry**

Replace Agent imports with:

```ts
import {
  AgentCancelled,
  AgentError,
  CodingAgent,
  FORCED_FINAL_PROMPT,
} from "../packages/core/agent-runtime/src/index.ts";
```

- [ ] **Step 2: Run Agent tests and verify missing package failure**

Run:

```bash
node --test scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/system-prompt.test.ts
```

Expected: FAIL on missing package entry.

- [ ] **Step 3: Create package metadata and move Agent-owned files**

Create the manifest with dependencies on runtime protocol, tools, llm, and
project instructions. Move the five listed source files into
`packages/core/agent-runtime/src/` and update imports to public package names.
Keep guard/history/step-runner imports relative because they are internal
implementation details.

- [ ] **Step 4: Inject model and tool implementations through contracts**

Change `CodingAgentOptions` to require the stable interfaces:

```ts
export interface CodingAgentOptions {
  readonly modelAdapter: ModelAdapter;
  readonly model: string;
  readonly provider: string | null;
  readonly tools: ToolRegistry;
  readonly projectRoot?: string | null;
  readonly startupCwd?: string | null;
}
```

Remove default Adapter registry resolution and concrete tool construction from
Agent runtime. `switchModel` receives a new `ModelAdapter` with model/provider:

```ts
switchModel(options: {
  readonly modelAdapter: ModelAdapter;
  readonly model: string;
  readonly provider: string;
}): void;
```

The CLI remains responsible for resolving the concrete Adapter.

- [ ] **Step 5: Add the public entry and verify Agent behavior**

Export only the public Agent classes, options, event callback types, and forced
final prompt. Run:

```bash
npm run build
node --test scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/system-prompt.test.ts scripts/model-runtime.test.ts scripts/tool-runtime.test.ts
npm test
```

Expected: all Agent guard, history, streaming, tool order, and cancellation
assertions pass.

- [ ] **Step 6: Commit Agent runtime package**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json packages/core/agent-runtime
git add src/agent.ts src/cli.ts src/commands.ts src/session.ts src/system-prompt.ts
git add src/core/agent-step-runner.ts src/core/guard-policy.ts src/core/history-committer.ts
git add scripts/agent.test.ts scripts/agent-step-runner.test.ts scripts/system-prompt.test.ts scripts/model-runtime.test.ts scripts/tool-runtime.test.ts scripts/cli.test.ts scripts/commands.test.ts scripts/session.test.ts
git commit -m "refactor: package agent runtime"
```

### Task 7: Move Session runtime without concrete Agent or CLI dependencies

**Files:**
- Create: `packages/core/session-runtime/package.json`
- Create: `packages/core/session-runtime/tsconfig.json`
- Create: `packages/core/session-runtime/src/index.ts`
- Move: `src/session.ts`
- Move: `src/routing.ts`
- Move: `src/core/agent-turn-loop.ts`
- Move: `src/core/human-intent-router.ts`
- Move: `src/core/queue-dispatcher.ts`
- Move: `src/core/task-lifecycle.ts`
- Modify: current CLI and command imports
- Modify: root and legacy tsconfig references
- Test: `scripts/session.test.ts`
- Test: `scripts/routing.test.ts`
- Test: `scripts/queue-dispatcher.test.ts`
- Test: `scripts/task-lifecycle.test.ts`
- Test: `scripts/agent-turn-loop.test.ts`

**Interfaces:**
- Consumes: runtime protocol only.
- Produces: `AgentSession`, `TaskContext`, Session state, submissions, routing decisions, queues, task lifecycle, and intent routing.

- [ ] **Step 1: Point Session tests at the future package entry**

Use:

```ts
import {
  AgentSession,
  EventRouter,
  PendingQueue,
  QueueDispatcher,
  SessionState,
  TaskContext,
  TaskLifecycle,
  routeHumanIntent,
} from "../packages/core/session-runtime/src/index.ts";
```

- [ ] **Step 2: Run Session tests and verify missing package failure**

Run:

```bash
node --test scripts/session.test.ts scripts/routing.test.ts scripts/queue-dispatcher.test.ts scripts/task-lifecycle.test.ts scripts/agent-turn-loop.test.ts
```

Expected: FAIL on missing package entry.

- [ ] **Step 3: Create package metadata and move Session-owned files**

Create a manifest depending only on `@laohuang/runtime-protocol`. Move the six
listed files. Move routing decision, semantic-classifier task snapshot, and
queue DTO types used by external callers into runtime protocol; keep queue
implementations inside Session runtime.

- [ ] **Step 4: Enforce concrete-dependency removal**

The resulting Session constructor remains structural:

```ts
export class AgentSession {
  constructor(runner: AgentRunner | TaskRunner, options?: AgentSessionOptions);
}
```

`AgentSessionOptions.semanticClassifier` uses the protocol interface.
`TaskContext implements AgentRuntimeContext`. Search and require no matches:

```bash
rg -n "CodingAgent|apps/cli|commands\.ts|@laohuang/agent-runtime" packages/core/session-runtime
```

Expected: no output.

- [ ] **Step 5: Build and verify Session behavior**

Run:

```bash
npm run build
node --test scripts/session.test.ts scripts/routing.test.ts scripts/queue-dispatcher.test.ts scripts/task-lifecycle.test.ts scripts/agent-turn-loop.test.ts scripts/session-action.test.ts
npm test
```

Expected: routing, queue claim/ack, cancellation, state transition, and held
queue behavior remain unchanged.

- [ ] **Step 6: Commit Session runtime package**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json packages/core/runtime-protocol packages/core/session-runtime
git add src/cli.ts src/commands.ts src/routing.ts src/session.ts
git add src/core/agent-turn-loop.ts src/core/human-intent-router.ts src/core/queue-dispatcher.ts src/core/task-lifecycle.ts
git add scripts/session.test.ts scripts/routing.test.ts scripts/queue-dispatcher.test.ts scripts/task-lifecycle.test.ts scripts/agent-turn-loop.test.ts scripts/session-action.test.ts scripts/cli.test.ts scripts/commands.test.ts
git commit -m "refactor: package session runtime"
```

### Task 8: Move the complete TUI as one deep package

**Files:**
- Create: `packages/terminal/tui/package.json`
- Create: `packages/terminal/tui/tsconfig.json`
- Create: `packages/terminal/tui/src/index.ts`
- Move: `src/tui/**`
- Move: `src/keybindings/**`
- Move: `src/capabilities.ts`
- Modify: current CLI and command imports
- Modify: root and legacy tsconfig references
- Test: all `scripts/tui-*.test.ts`, `scripts/display-policy.test.ts`, `scripts/frame-builder.test.ts`, `scripts/overlay-focus.test.ts`, `scripts/capabilities.test.ts`, `scripts/keybindings.test.ts`, `scripts/ui-state.test.ts`

**Interfaces:**
- Consumes: runtime events and event envelopes from runtime protocol.
- Produces: `TerminalUI`, terminal drivers/sinks, prompt errors, TUI public state, and structural command completion input. TUI components and contracts remain private implementation details.

- [ ] **Step 1: Point TUI tests at the future package source entry**

For public behavior, import from:

```ts
import {
  MemoryTerminalDriver,
  PlainEventSink,
  PromptCancelledError,
  PromptEofError,
  TerminalUI,
} from "../packages/terminal/tui/src/index.ts";
```

Tests dedicated to internal screen/editor/Markdown implementation may import
relative files inside the same package source tree.

- [ ] **Step 2: Run the focused group and verify missing package failure**

Run:

```bash
node --test scripts/tui-*.test.ts scripts/display-policy.test.ts scripts/frame-builder.test.ts scripts/overlay-focus.test.ts scripts/capabilities.test.ts scripts/keybindings.test.ts scripts/ui-state.test.ts
```

Expected: FAIL on missing package entry.

- [ ] **Step 3: Create package metadata and move TUI sources**

Create the TUI manifest depending only on runtime protocol. Move directories
explicitly:

```bash
mkdir -p packages/terminal/tui/src
git mv src/tui packages/terminal/tui/src/tui
git mv src/keybindings packages/terminal/tui/src/keybindings
git mv src/capabilities.ts packages/terminal/tui/src/capabilities.ts
```

Move `packages/terminal/tui/src/tui/AGENTS.md` to
`packages/terminal/tui/AGENTS.md` so its instructions govern the whole package.
Correct internal relative imports without flattening the implementation.

- [ ] **Step 4: Define the package's public entry**

Export the CLI-consumed surface only:

```ts
export * from "./capabilities.ts";
export * from "./tui/input.ts";
export {
  MemoryTerminalDriver,
  PlainEventSink,
  StdTerminalDriver,
  TerminalUI,
  type LoopInputSource,
  type SubmitOptions,
} from "./tui/ui.ts";
```

Do not export components, screen helpers, Markdown internals, focus manager,
or private TUI contracts from the package root.

- [ ] **Step 5: Build and run all terminal tests**

Run:

```bash
npm run build
node --test scripts/tui-*.test.ts scripts/display-policy.test.ts scripts/frame-builder.test.ts scripts/overlay-focus.test.ts scripts/capabilities.test.ts scripts/keybindings.test.ts scripts/ui-state.test.ts
npm test
```

Expected: all tests pass with unchanged rendering snapshots and input behavior.

- [ ] **Step 6: Commit the TUI package**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json packages/terminal/tui
git add src/cli.ts src/commands.ts src/capabilities.ts src/keybindings src/tui
git add scripts/tui-editor.test.ts scripts/tui-input-event.test.ts scripts/tui-input.test.ts scripts/tui-markdown.test.ts scripts/tui-screen.test.ts scripts/tui-ui.test.ts scripts/display-policy.test.ts scripts/frame-builder.test.ts scripts/overlay-focus.test.ts scripts/capabilities.test.ts scripts/keybindings.test.ts scripts/ui-state.test.ts scripts/cli.test.ts scripts/commands.test.ts scripts/command-entry.test.ts
git commit -m "refactor: package terminal tui"
```

### Task 9: Create the published CLI app and bundled artifact

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/build.mjs`
- Create: `apps/cli/README.md`
- Create: `apps/cli/LICENSE`
- Create: `apps/cli/src/args.ts`
- Create: `apps/cli/src/bin.ts`
- Create: `apps/cli/src/main.ts`
- Create: `apps/cli/src/repl.ts`
- Move: `src/commands.ts`
- Move: `src/model-selection.ts`
- Move: `src/semantic-classifier.ts`
- Split and remove: `src/cli.ts`
- Remove: `tsconfig.legacy.json`
- Remove: final empty root `src/`
- Modify: root `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`
- Test: `scripts/cli.test.ts`
- Test: `scripts/command-entry.test.ts`
- Test: `scripts/commands.test.ts`
- Test: `scripts/model-selection.test.ts`
- Test: `scripts/semantic-classifier.test.ts`
- Test: `scripts/package-smoke.mjs`

**Interfaces:**
- Consumes: all concrete packages and public protocol interfaces.
- Produces: one published `laohuang` package with `dist/bin.js`; no published dependency on private workspaces.

- [ ] **Step 1: Change CLI tests to the future app modules**

Use:

```ts
import { VERSION, main } from "../apps/cli/src/main.ts";
import {
  runPlainSessionRepl,
  runRepl,
  runSessionRepl,
  supportsTerminalUI,
  terminalUiPrompts,
} from "../apps/cli/src/repl.ts";
import { SessionCommands } from "../apps/cli/src/commands.ts";
```

Change spawned built-entry paths from `dist/cli.js` to
`apps/cli/dist/bin.js`.

- [ ] **Step 2: Run CLI tests and verify missing app failure**

Run:

```bash
node --test scripts/cli.test.ts scripts/command-entry.test.ts scripts/commands.test.ts scripts/model-selection.test.ts scripts/semantic-classifier.test.ts
```

Expected: FAIL on missing app modules.

- [ ] **Step 3: Create the app manifest and build configuration**

Create `apps/cli/package.json` with current repository metadata and version
`0.4.2`, `bin.laohuang = dist/bin.js`, `files = ["dist/bin.js", "README.md",
"LICENSE"]`, runtime dependency `openai@^6.49.0`, and internal workspace
packages as `devDependencies` at version `0.0.0`.

Create `apps/cli/tsconfig.json` extending the base config, using `rootDir: src`,
`outDir: .build`, `composite: true`, and references to every package consumed
by the app. Add `.build/` to `.gitignore`.

Install esbuild without lifecycle scripts:

```bash
npm install --save-dev --ignore-scripts esbuild
```

- [ ] **Step 4: Add the exact bundle build**

Create `apps/cli/build.mjs`:

```js
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await rm(new URL("./dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: [fileURLToPath(new URL("./src/bin.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("./dist/bin.js", import.meta.url)),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["openai"],
});
```

Root build becomes:

```json
{
  "scripts": {
    "build": "tsc -b && npm run bundle --workspace laohuang"
  }
}
```

The app manifest defines `"bundle": "node build.mjs"`.

- [ ] **Step 5: Split the monolithic CLI without behavior changes**

Move argument types, help/usage constants, and parsing into `args.ts`; REPL and
terminal support functions into `repl.ts`; configuration and concrete
composition into `main.ts`; direct execution into `bin.ts`. `bin.ts` contains
only:

```ts
#!/usr/bin/env node
import { main } from "./main.ts";

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`laohuang: ${message}\n`);
    process.exitCode = 1;
  },
);
```

Move commands, model selection, and semantic classifier into app source.
Compose all concrete packages in `main.ts`; no other package imports app code.

- [ ] **Step 6: Move public package documentation and finish root cleanup**

Create `apps/cli/LICENSE` with the exact current root MIT license text. Create
`apps/cli/README.md` containing installation, `laohuang --help`, configuration,
and a link to the repository README. Remove root public name/version/bin/files,
dependencies, repository publishing metadata, and `tsconfig.legacy.json` only
after app metadata is complete. Delete the empty root `src/` directory.

- [ ] **Step 7: Refresh lockfile, build, and test the app**

Run:

```bash
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run build
node apps/cli/dist/bin.js --version
node --test scripts/cli.test.ts scripts/command-entry.test.ts scripts/commands.test.ts scripts/model-selection.test.ts scripts/semantic-classifier.test.ts
npm test
npm run smoke:package
```

Expected: version prints `laohuang 0.4.2`, tests pass, and package smoke
installs and runs the app without private package resolution.

- [ ] **Step 8: Commit the CLI application workspace**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.legacy.json tsconfig.base.json .gitignore apps/cli
git add src/cli.ts src/commands.ts src/model-selection.ts src/semantic-classifier.ts
git add scripts/cli.test.ts scripts/command-entry.test.ts scripts/commands.test.ts scripts/model-selection.test.ts scripts/semantic-classifier.test.ts scripts/package-smoke.mjs
git commit -m "refactor: publish cli from app workspace"
```

### Task 10: Enforce architecture and update engineering/release documentation

**Files:**
- Create: `scripts/workspace-architecture.test.ts`
- Modify: `scripts/check-package-version.mjs`
- Modify: `scripts/package-smoke.mjs`
- Modify: `scripts/profile-cli.mjs`
- Modify: `scripts/verify-published-version.mjs`
- Modify: `scripts/engineering-scripts.test.ts`
- Modify: `scripts/tui-smoke.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `AGENTS.md`
- Modify: `scripts/AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/configuration.md`
- Modify: `docs/security.md`
- Modify: `docs/npm-distribution.md`
- Modify: `docs/publishing.md`
- Modify outside repo: `/Users/huangxurui/obsidian-all/all/laoHuangCode/项目代码目录结构图.md`

**Interfaces:**
- Consumes: final workspace manifests, app bundle, and existing release contract.
- Produces: automated architecture invariants, workspace-aware CI/release/package checks, and synchronized documentation.

- [ ] **Step 1: Write the architecture enforcement test**

Create `scripts/workspace-architecture.test.ts` using Node standard library.
The test must parse manifests and source imports and assert:

```ts
test("workspace owns every production source through acyclic public packages", () => {
  assert.equal(rootManifest.private, true);
  assert.deepEqual(rootManifest.workspaces, ["apps/*", "packages/*/*"]);
  assert.deepEqual(listDirectories("apps"), ["cli"]);
  assert.equal(existsSync("src"), false);

  for (const packageRoot of listPackageRoots("packages")) {
    assert.equal(existsSync(join(packageRoot, "package.json")), true);
    assert.equal(existsSync(join(packageRoot, "tsconfig.json")), true);
    assert.equal(existsSync(join(packageRoot, "src", "index.ts")), true);
    const manifest = readManifest(packageRoot);
    assert.equal(manifest.private, true);
    assert.deepEqual(Object.keys(manifest.exports), ["."]);
  }

  assert.deepEqual(findCrossPackageRelativeImports(), []);
  assert.deepEqual(findDeepWorkspaceImports(), []);
  assert.deepEqual(findWorkspaceDependencyCycles(), []);
});
```

Implement `listDirectories`, `listPackageRoots`, `readManifest`,
`findCrossPackageRelativeImports`, `findDeepWorkspaceImports`, and
`findWorkspaceDependencyCycles` in the same test file. Resolve every relative
specifier against its source file and compare the resolved path with the
owning app/package root. Treat imports containing `/src/` or `/dist/` after an
`@laohuang/` prefix as deep imports. Use depth-first search with `visiting` and
`visited` sets for manifest cycles.

- [ ] **Step 2: Run the architecture test and fix every concrete violation**

Run:

```bash
node --test scripts/workspace-architecture.test.ts
```

Expected first run: FAIL on any remaining root source, deep import, missing
entry, internal app runtime dependency, or cycle. Fix the reported exact paths
until the test passes. Do not weaken an assertion to accept the violation.

- [ ] **Step 3: Make engineering scripts app-workspace aware**

Use this shared path contract in the four npm scripts:

```js
const appRoot = join(repositoryRoot, "apps", "cli");
const appManifestPath = join(appRoot, "package.json");
const appBinPath = join(appRoot, "dist", "bin.js");
```

`check-package-version.mjs` and `verify-published-version.mjs` read the app
version. `package-smoke.mjs` runs
`npm pack --workspace laohuang --json`, installs that tarball into a temporary
directory, and checks `laohuang --version`. `profile-cli.mjs` profiles the app
bundle. `tui-smoke.sh` runs `node apps/cli/dist/bin.js`.

- [ ] **Step 4: Update CI and release**

Change CI built-entry checks to:

```yaml
- run: node apps/cli/dist/bin.js --version
```

Release reads version from `apps/cli/package.json` and publishes:

```yaml
- name: Read the release version
  id: package
  run: echo "version=$(node --print 'require("./apps/cli/package.json").version')" >> "$GITHUB_OUTPUT"
- name: Publish npm package with trusted publishing
  run: npm publish --workspace laohuang --access public
```

Keep the existing merged-PR gate, Node versions, Trusted Publishing,
concurrency, permissions, and registry verification.

- [ ] **Step 5: Update repository instructions and documentation**

Replace root `src/` rules with the exact workspace contract. Update examples
from `git add src/foo.ts` to explicit app/package paths, and interactive smoke
paths to `apps/cli/dist/bin.js`. Move the TUI-specific instructions to
`packages/terminal/tui/AGENTS.md`. Keep tests and automation under `scripts/`.

Update README and docs to show the final tree, package dependency graph,
single bundled artifact, app version ownership, package smoke command, and
release workspace command. Security documentation must still state that Bash
has current-user OS permissions and no sandbox.

Update the Obsidian document's LaoHuangCode diagram and first/second-level
table to show `apps/`, `packages/`, and `scripts/`; under `packages/`, list only
its direct domain children, and under each selected domain list only its direct
package children. Do not include third-level implementation files in that
table.

- [ ] **Step 6: Run complete local verification**

Run:

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run check:version
npm run smoke:package
npm run smoke:tui
git diff --check
```

Expected: every command passes. If `tmux` is unavailable, `smoke:tui` may be
reported as the sole environment-blocked check only after confirming the
script fails specifically because `tmux` is missing.

- [ ] **Step 7: Inspect the published tarball contract**

Run:

```bash
npm pack --workspace laohuang --json
```

Inspect the JSON file list. Expected package contents include
`package.json`, `dist/bin.js`, its source map, `README.md`, and `LICENSE`; they
exclude TypeScript source, `.build`, repository docs, scripts, and private
workspace packages. Remove the generated tarball after inspection using its
exact reported filename.

- [ ] **Step 8: Commit enforcement and documentation**

Stage repository files explicitly and do not stage the external Obsidian file:

```bash
git add scripts/workspace-architecture.test.ts scripts/check-package-version.mjs scripts/package-smoke.mjs scripts/profile-cli.mjs scripts/verify-published-version.mjs scripts/engineering-scripts.test.ts scripts/tui-smoke.sh
git add .github/workflows/ci.yml .github/workflows/release.yml AGENTS.md scripts/AGENTS.md README.md
git add docs/architecture.md docs/configuration.md docs/security.md docs/npm-distribution.md docs/publishing.md
git commit -m "docs: finalize workspace package architecture"
```

Report the Obsidian update separately because it is outside this Git
repository.
