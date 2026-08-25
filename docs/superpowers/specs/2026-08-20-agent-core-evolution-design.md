# Agent Core Evolution Design

## Status and scope

This document is the agreed design for GitHub Issue #6. It covers the fixed built-in tool upgrade, the minimum OpenAI/DeepSeek model-adapter boundary, a stable System Prompt assembled from tool guidelines, and DSH-style project-instruction context. It does not implement any of those changes.

The active tool set remains exactly `read`, `write`, `edit`, and `bash`. MCP, runtime-added tools, prompt snippets, additional model providers, LiteLLM, Pi bridges, jobs, and a real sandbox are outside this work.

## Goals

1. Give each fixed tool one owner for its schema, description, and behavioral guidance.
2. Keep the System Prompt and sent tool schemas deterministic for the lifetime of a session.
3. Load repository instructions without embedding mutable project content in the System Prompt.
4. Permit a running agent to discover more-specific directory instructions without invalidating the request prefix.
5. Separate provider-specific request, streaming, history, and error details from `CodingAgent`.

## Context assembly

The model receives three separate context channels. They have distinct owners and must not be collapsed into one prompt string.

```text
stable System Prompt                 tools request parameter
--------------------                 -----------------------
base agent behavior                  description + JSON Schema
fixed tool guidelines                for read/write/edit/bash

conversation history
--------------------
user request
project-instruction reminders
assistant/tool/tool-result messages
```

`CodingAgent.messages` stays the canonical ordered history. The first element is the stable system message. The tool list is passed separately to the model adapter. Project rules are durable user-role history messages with a plugin-owned `<system-reminder>` wrapper.

### Stable System Prompt

`build_system_prompt(tool_registry)` replaces the module-level static string. It is evaluated when a `CodingAgent` is created and its result does not change during that agent's lifetime.

The exact baseline is:

```text
You are laoHuangCode, a coding agent.

General guidelines:
- Work only within the configured project root.
- Follow direct user instructions. Project instructions may provide additional guidance.
- Inspect relevant files before changing them.
- Prefer the smallest change that fully satisfies the request.
- Verify changes when practical.
- Keep the final response concise and state what changed.

Tool guidelines:

## read
<read guidelines>

## write
<write guidelines>

## edit
<edit guidelines>

## bash
<bash guidelines>
```

The builder supplies the title and general guidelines. Tools own the text in their respective sections. The builder uses the fixed order `read`, `write`, `edit`, `bash`, regardless of storage order or Python dictionary iteration. It does not emit an Available Tools section, `promptSnippet`, full tool descriptions, schemas, cwd, absolute paths, or project instruction content.

The existing `FORCED_FINAL_PROMPT` is retained. When a guard triggers, `CodingAgent` makes a temporary copy of the stable system message and appends it only to the in-flight request. Neither the stored system message nor history changes.

### Tool definitions and guidelines

Introduce an internal immutable `ToolSpec` (or equivalent) with these fields:

```text
name
description
parameters
prompt_guidelines: tuple[str, ...]
```

`ToolRegistry.definitions` serializes only `name`, `description`, and `parameters` into the OpenAI-compatible tools payload. `prompt_guidelines` is never included in that schema. `ToolRegistry` also exposes the ordered active specs to the System Prompt builder.

Guideline content is:

| Tool | Required guidance |
| --- | --- |
| `read` | Use for ordinary file inspection rather than `cat`/`sed`; use offset/limit for large files; inspect before changing an existing file. |
| `write` | Only create a file or replace all of one; use `edit` for local changes; confirm path and complete content first. |
| `edit` | Use for local changes; targets must exactly and uniquely match the original file; batched edits cannot overlap; inspect first and verify when practical. |
| `bash` | Supply a concise description; use `workdir` instead of `cd`; calls are independent shells; inspect non-zero exit output before retrying. |

The tool behavior changes are specified by Issue #6: paginated `read`, whole-file `write`, batched strict `edit`, and DSH-inspired `bash` arguments. Runtime validation, root confinement, locks, cancellation, and output sanitization remain enforcement mechanisms rather than prompt instructions.

## Project instructions

### Discovery model

Create `project_instructions.py`, owned by the agent layer rather than tools. Its input is the configured project root and the agent's startup cwd. The first phase has these candidates only:

```text
AGENTS.md
CLAUDE.md
```

The project root is the nearest ancestor containing `.git`; if no ancestor contains it, use the configured project root. Discovery walks root to cwd inclusively. Within a directory, `AGENTS.md` precedes `CLAUDE.md`; both are included if present and not content-identical after leading/trailing whitespace is removed. The rendered sequence is broad-to-specific so later instructions naturally have higher priority.

Files must be regular UTF-8 text files inside the project root. Do not follow an instruction-file symlink that resolves outside it in this phase. Read each file with a per-file cap and render the complete baseline under a configurable total byte budget. The design default is 64 KiB total and 1 MiB per source file. If pressure exists, omit whole broad files before truncating the most specific retained file; include a visible omission/truncation notice. No context file means no injected message.

### Baseline injection

At the start of `CodingAgent.run`, first commit the direct user message using the existing cancellation/session coordination path. Before the first model request of that turn, append one instruction message when the rendered baseline is non-empty:

```md
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: AGENTS.md

...
</system-reminder>
```

The renderer owns the complete wrapper. It escapes every literal `</system-reminder>` in file content and displayed paths. Instruction text is repository-controlled and is never treated as higher-authority system text.

The ordering for the first request is always:

```text
stable system message
user's direct message
baseline project-instruction message, if any
model request
```

The baseline is injected once per agent session. It is not duplicated on later user turns. A private `ProjectInstructionState` records the loaded scope and digest for each visible instruction file. This state is not model-visible and never changes message content already committed to history.

### Dynamic descendant discovery

The first release includes DSH-style dynamic discovery, but not mutation reconciliation.

After a successful `read`, `write`, or `edit` tool call, `CodingAgent` receives the successfully touched resolved path. After committing all paired tool results, it calls `discover_for_touched_paths(paths)`. For every parent directory from project root to the touched path's directory, the service checks its instruction candidates. Rules in a scope not already represented by `ProjectInstructionState` are rendered as one or more additional instruction messages.

Those messages are appended after the tool results and before the next model request:

```text
assistant tool call
tool result
<system-reminder>Additional instructions from: packages/api/AGENTS.md ...</system-reminder>
next model request
```

No shell command is parsed for `cd` or path discovery. `bash` is deliberately excluded because commands are arbitrary syntax and every call uses a fresh shell. A failed, cancelled, out-of-root, or blocked file operation yields no discovery.

In the current code, `ToolRegistry.execute()` returns a public result dictionary. The implementation must add an internal execution outcome or a side channel that records resolved touched paths only after successful first-party file tools. It must not expose host absolute paths solely for this bookkeeping.

### Deferred reconciliation

These operations are intentionally not implemented in the first release, but the `ProjectInstructionState` interface must support them:

- append a replacement reminder when a previously loaded rule changes;
- append a removal reminder when it disappears or becomes a duplicate;
- resume-session reconciliation and digest-based suppression across persisted history;
- global `~/.laohuangcode/AGENTS.md` and local-overlay candidates;
- file watchers.

The future behavior remains append-only: a replacement says that newer content supersedes earlier content, rather than editing old history. This preserves cache eligibility and accurately records what the model saw at every stage.

## Cache invariants

For a session, the following must remain byte-stable and ordered identically:

1. the base System Prompt;
2. the serialized tool schemas and tool array order;
3. all already committed messages.

Project instruction discovery only appends messages. It must never rebuild the System Prompt, rewrite the initial baseline, or move an instruction ahead of previously committed history. This makes every next request an exact extension of the preceding request. Providers can therefore reuse a cached prefix when their own cache policy, model, credentials, and time window permit it; the application cannot guarantee that a provider will report a cache hit.

## Model adapter boundary

`CodingAgent` speaks provider-neutral request and event types:

```text
ModelRequest
  model, normalized history, tools, tool choice, cancellation, callbacks
ModelEvent
  text, reasoning, tool-call delta, usage, finish
ModelError
  authentication, rate_limited, context_overflow, server, retryable
ModelCapabilities
  supported request/history/streaming behavior
```

`AdapterRegistry` chooses either `OpenAIAdapter` or `DeepSeekAdapter`. Each adapter translates the neutral request into the provider's OpenAI-SDK request shape, parses raw streaming chunks into `ModelEvent`s, retains any provider-private replay data, and normalizes errors. `CodingAgent` owns its tool loop, budgets, cancellation policy, and the decision to retry, compact, or notify the user.

The neutral history contains portable assistant content and tool calls. An adapter may preserve opaque replay state for a same-provider continuation, such as DeepSeek reasoning data needed by a tool-call chain. `switch_model()` discards or downgrades that opaque state while retaining portable history.

The first adapters are intentionally narrow:

- `OpenAIAdapter` preserves the current Chat Completions request and stream behavior.
- `DeepSeekAdapter` validates/translates thinking settings, handles `reasoning_content` replay and tool-call empty-content conventions, and classifies provider errors.

Anthropic, Gemini, Bedrock, Vertex, LiteLLM, Pi/`pi-ai`, specialized authentication, multimodal data, provider cache dialects, and session affinity remain out of scope.

## Integration sequence

1. Replace raw `TOOL_DEFINITIONS` with ordered internal specs and add System Prompt assembly. Preserve the emitted tools payload exactly except for the separately agreed schema upgrades.
2. Add project-instruction discovery/rendering and construct `CodingAgent` with project root/startup cwd from the CLI.
3. Inject the baseline after a direct user message and add dynamic descendant discovery after successful file-tool results.
4. Introduce neutral adapter types and registry; move current streaming functionality behind `OpenAIAdapter` before adding `DeepSeekAdapter` behavior.

Each step has a standalone test seam and does not require MCP or a dynamic tool registry.

## Verification

Add focused tests for:

- stable System Prompt snapshot and fixed guideline order;
- absence of `promptGuidelines` from serialized tool schemas;
- baseline chain discovery, same-directory precedence/deduplication, budget behavior, and wrapper escaping;
- first-request order: direct user message, then baseline reminder;
- dynamic descendant discovery only after successful `read`/`write`/`edit`, after paired tool results, and never through `bash`;
- no duplicate reminder when a scope was already loaded;
- guard prompt is request-local and does not mutate stored history;
- adapter contract tests that give both adapters the same neutral request and assert normalized text, reasoning, tool calls, usage, finish, cancellation, and error classifications.

No claim of cache-hit behavior belongs in a unit test. Tests instead assert the byte-stability and append-only invariants that preserve eligibility.
