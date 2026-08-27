# LaoHuang TUI Component System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Componentize every currently exposed LaoHuang interactive TUI feature with typed view models, reusable Pi-style components, centralized semantic styling, and no command-generated grey text lists.

**Architecture:** Keep `InteractiveTerminalLoop`, raw terminal input, native scrollback, and `PiMainScreenRenderer`. Add a Codex-style `StyledLine`/`StyledSpan` render model, Pi-style layout and selection primitives, typed transcript/message components, a focused view host, and interactive/plain command presenters; compile structured lines to ANSI only at the `ScreenFrame` boundary.

**Tech Stack:** TypeScript 5.5 with erasable syntax, Node.js 22.19+, npm workspaces, built-in `node:test`, existing `@laohuang/tui`, `@laohuang/runtime-protocol`, and `@laohuang/llm`; no new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-08-27-tui-component-system-design.md`

## Global Constraints

- Execute in an isolated worktree created with `superpowers:using-git-worktrees`; use a `codex/` branch based on the then-current `develop` branch.
- Preserve unrelated changes and untracked files; stage only paths named by the active task.
- Do not modify `PiMainScreenRenderer`, `StdinBuffer`, `TerminalInputFilter`, `RawInputDecoder`, AgentSession, event schemas, model adapters, provider catalog semantics, credential storage, or tool runtime except for type-compatible call-site adaptation explicitly listed below.
- `InteractiveTerminalLoop` remains the only interactive stdout writer.
- `PiMainScreenRenderer` continues to consume ANSI string lines and remains responsible for terminal diffing, native scrollback, synchronized output, resize, and hardware cursor placement.
- Components emit `StyledLine`/`StyledSpan`; they do not embed ANSI or literal hex colors.
- An omitted foreground means terminal default foreground. Ordinary input, assistant body text, and unselected names must omit foreground styling.
- `--help`, `--version`, piped sessions, setup prompts, and `PlainEventSink` remain append-only plain text.
- Secret values must never appear in transcript blocks, terminal writes, presentation models, test snapshots, errors, or logs.
- Do not add Ink, React, Ratatui, prompt_toolkit, or any new npm dependency.
- Keep TypeScript directly executed by Node tests erasable: no `enum`, namespace, parameter properties, `import =`, or dynamic type imports.
- Each task follows TDD, runs its focused tests, then runs `npm run build` and `npm test` before its commit.
- Do not run real provider calls or tests requiring API keys.

---

## File Structure

### New `@laohuang/tui` files

| File | Responsibility |
| --- | --- |
| `packages/terminal/tui/src/tui/render-model.ts` | Typed style tokens, spans, lines, render context/results, and constructors. |
| `packages/terminal/tui/src/tui/ansi-renderer.ts` | Convert structured lines to width-safe ANSI strings using `TerminalTheme`. |
| `packages/terminal/tui/src/tui/components/primitives/text.ts` | Width-aware text wrapping, padding, background fill, and cache. |
| `packages/terminal/tui/src/tui/components/primitives/v-stack.ts` | Ordered vertical composition with explicit gaps. |
| `packages/terminal/tui/src/tui/components/primitives/box.ts` | Child padding and optional semantic background. |
| `packages/terminal/tui/src/tui/components/primitives/select-list.ts` | Generic filtered, scrollable, focusable selector. |
| `packages/terminal/tui/src/tui/components/primitives/search-input.ts` | Single-line searchable input backed by `EditorState`. |
| `packages/terminal/tui/src/tui/components/composer.ts` | Structured prompt/editor component backed by existing `EditorState`. |
| `packages/terminal/tui/src/tui/components/status-line.ts` | Responsive cwd/queue/token/provider/model/effort footer. |
| `packages/terminal/tui/src/tui/components/messages/user-message.ts` | User transcript block. |
| `packages/terminal/tui/src/tui/components/messages/assistant-message.ts` | Assistant Markdown transcript block. |
| `packages/terminal/tui/src/tui/components/messages/thinking-message.ts` | Reasoning transcript block. |
| `packages/terminal/tui/src/tui/components/messages/tool-message.ts` | Tool and bash status/output transcript block. |
| `packages/terminal/tui/src/tui/components/messages/notice-message.ts` | Info, success, warning, and error messages. |
| `packages/terminal/tui/src/tui/components/messages/welcome-message.ts` | Welcome/session identity display. |
| `packages/terminal/tui/src/tui/components/views/contracts.ts` | Generic help, selection, prompt, provider, and queue view models. |
| `packages/terminal/tui/src/tui/components/views/help-view.ts` | Structured command help. |
| `packages/terminal/tui/src/tui/components/views/provider-status-view.ts` | Provider list and detail views. |
| `packages/terminal/tui/src/tui/components/views/queue-status-view.ts` | Queue state view. |
| `packages/terminal/tui/src/tui/components/views/model-selector.ts` | Searchable provider/model selector composition. |
| `packages/terminal/tui/src/tui/components/views/effort-selector.ts` | Reasoning effort selector. |
| `packages/terminal/tui/src/tui/components/views/auth-dialog.ts` | Text, secret, and option prompts. |
| `packages/terminal/tui/src/tui/view-host.ts` | Promise lifecycle and focused overlay ownership. |
| `packages/terminal/tui/src/tui/main-screen.ts` | Unframed transcript/dock composition and cursor metadata. |

### New CLI files

| File | Responsibility |
| --- | --- |
| `apps/cli/src/command-presentation.ts` | UI-neutral presentation models and `CommandPresenter` port. |
| `apps/cli/src/plain-command-presenter.ts` | Append-only text formatting for plain sessions. |
| `apps/cli/src/terminal-command-presenter.ts` | Map command presentation models to TUI blocks and interactive views. |

### New tests

| File | Responsibility |
| --- | --- |
| `scripts/tui-render-model.test.ts` | Structured text and ANSI compiler. |
| `scripts/tui-primitives.test.ts` | Text, stack, box, search, and selection behavior. |
| `scripts/tui-message-components.test.ts` | Transcript component snapshots and typed blocks. |
| `scripts/tui-command-views.test.ts` | Help/provider/queue/model/effort/auth component rendering and input. |
| `scripts/command-presentation.test.ts` | Interactive/plain presenter equivalence and secret boundaries. |
| `scripts/helpers/command-presentation-fixture.ts` | Shared recording presenter for command and integration tests. |
| `scripts/helpers/session-command-fixture.ts` | Shared fake catalog/auth/agent/session and `SessionCommands` factory. |

---

### Task 1: Structured Render Model and ANSI Compiler

**Files:**
- Create: `packages/terminal/tui/src/tui/render-model.ts`
- Create: `packages/terminal/tui/src/tui/ansi-renderer.ts`
- Create: `scripts/tui-render-model.test.ts`
- Modify: `packages/terminal/tui/src/tui/theme.ts`
- Modify: `packages/terminal/tui/src/tui/component.ts`
- Modify: `packages/terminal/tui/src/tui/components/rendering.ts`
- Modify: `packages/terminal/tui/src/tui/components/completion-list.ts`
- Modify: `packages/terminal/tui/src/tui/components/tool-card.ts`
- Modify: `packages/terminal/tui/src/tui/components/transcript.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`

**Interfaces:**
- Consumes: `TerminalTheme.color(token)`, `visibleWidth(text)`, `truncateToWidth(text, width)` from the existing TUI.
- Produces: `StyleToken`, `SpanStyle`, `StyledSpan`, `StyledLine`, `RenderContext`, `ComponentRenderResult`, `span()`, `line()`, `plainLine()`, `lineText()`, `wrapStyledSpans()`, `truncateStyledLine()`, `padStyledLine()`, `compileStyledLine()`, and `compileStyledLines()`.

- [ ] **Step 1: Write failing render-model tests**

Create `scripts/tui-render-model.test.ts` with exact assertions for default foreground, semantic color, attributes, CJK width, and over-width rejection:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  compileStyledLine,
  compileStyledLines,
} from "../packages/terminal/tui/src/tui/ansi-renderer.ts";
import {
  line,
  lineText,
  span,
} from "../packages/terminal/tui/src/tui/render-model.ts";
import { PI_DARK } from "../packages/terminal/tui/src/tui/theme.ts";

test("default foreground stays unstyled", () => {
  const rendered = compileStyledLine(line(span("plain")), 20, PI_DARK);
  assert.equal(rendered, "plain");
});

test("semantic spans compile at the ANSI boundary", () => {
  const source = line(
    span("selected", { foreground: "accent", bold: true }),
    span(" description", { foreground: "muted" }),
  );
  const rendered = compileStyledLine(source, 40, PI_DARK);
  assert.equal(lineText(source), "selected description");
  assert.match(rendered, /\x1b\[/u);
  assert.equal(rendered.replace(/\x1b\[[0-9;]*m/gu, ""), "selected description");
});

test("compiler rejects a line wider than terminal cells", () => {
  assert.throws(
    () => compileStyledLines([line(span("中文ab"))], 5, PI_DARK),
    /rendered line exceeds terminal width/u,
  );
});
```

- [ ] **Step 2: Run the new test and verify the missing-module failure**

Run: `node --test scripts/tui-render-model.test.ts`

Expected: FAIL because `render-model.ts` and `ansi-renderer.ts` do not exist.

- [ ] **Step 3: Add typed render-model constructors**

Implement `render-model.ts` with the spec's exact unions and these helpers:

```ts
export function span(text: string, style?: SpanStyle): StyledSpan {
  return style === undefined ? { text } : { text, style };
}

export function line(...spans: readonly StyledSpan[]): StyledLine {
  return { spans };
}

export function plainLine(text: string): StyledLine {
  return line(span(text));
}

export function lineText(value: StyledLine): string {
  return value.spans.map((item) => item.text).join("");
}

export function wrapStyledSpans(
  spans: readonly StyledSpan[],
  width: number,
): StyledLine[];

export function truncateStyledLine(
  value: StyledLine,
  width: number,
  ellipsis?: string,
): StyledLine;

export function padStyledLine(
  value: StyledLine,
  width: number,
  background?: StyleToken,
): StyledLine;
```

The width helpers preserve span styles while splitting only at Unicode codepoint
boundaries and measuring terminal cells with `charCellWidth`. `padStyledLine`
adds an uncolored padding span or a background-only padding span.

Type `TerminalTheme.colors`, `color()`, and `sgr()` with `StyleToken`. Remove
`selected_bg` because selected rows use accent foreground without background.

- [ ] **Step 4: Implement the single ANSI compilation boundary**

Implement `ansi-renderer.ts` so attributes and foreground/background tokens
become SGR codes, every styled span resets, and visible width is validated:

```ts
export function compileStyledLine(
  value: StyledLine,
  width: number,
  theme: TerminalTheme,
): string {
  const text = value.spans.map((item) => compileSpan(item, theme)).join("");
  if (visibleWidth(text) > width) {
    throw new Error(
      `rendered line exceeds terminal width: ${visibleWidth(text)} > ${width}`,
    );
  }
  return text;
}

export function compileStyledLines(
  values: readonly StyledLine[],
  width: number,
  theme: TerminalTheme,
): string[] {
  return values.map((value) => compileStyledLine(value, width, theme));
}
```

Move reusable ANSI parsing internals out of `components/rendering.ts`. Define a
temporary `LegacyTuiComponent` contract for the three existing string-rendering
components while new components adopt the structured contract:

```ts
export interface LegacyTuiComponent {
  render(width: number): readonly string[];
  invalidate(): void;
}
```

Change `CompletionList`, `ToolCard`, and `Transcript` to implement
`LegacyTuiComponent`. This keeps Task 1 buildable without placing existing ANSI
strings inside `StyledSpan.text`. Task 3 migrates `ToolCard` and `Transcript`;
Task 7 migrates `CompletionList` and removes `LegacyTuiComponent`.

- [ ] **Step 5: Update the component contract**

Change `TuiComponent.render` to accept `RenderContext` and return
`ComponentRenderResult`. Keep `FocusableComponent.focused` unchanged:

```ts
export interface TuiComponent {
  render(context: RenderContext): ComponentRenderResult;
  handleInput?(event: TuiInputEvent): boolean;
  invalidate(): void;
}
```

New primitives and components implement `TuiComponent`. Existing
`CompletionList`, `ToolCard`, and `Transcript` use the explicitly named
`LegacyTuiComponent` contract described in Step 4; no adapter may wrap an ANSI
string as a plain span. The legacy contract is deleted in Task 7 after its last
consumer is migrated.

- [ ] **Step 6: Run focused and repository verification**

Run:

```bash
node --test scripts/tui-render-model.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add packages/terminal/tui/src/tui/render-model.ts packages/terminal/tui/src/tui/ansi-renderer.ts packages/terminal/tui/src/tui/theme.ts packages/terminal/tui/src/tui/component.ts packages/terminal/tui/src/tui/components/rendering.ts packages/terminal/tui/src/tui/components/completion-list.ts packages/terminal/tui/src/tui/components/tool-card.ts packages/terminal/tui/src/tui/components/transcript.ts packages/terminal/tui/src/tui/components.ts scripts/tui-render-model.test.ts
git diff --cached --check
git commit -m "feat(tui): add structured render model"
```

---

### Task 2: Pi-Style Layout and Selection Primitives

**Files:**
- Create: `packages/terminal/tui/src/tui/components/primitives/text.ts`
- Create: `packages/terminal/tui/src/tui/components/primitives/v-stack.ts`
- Create: `packages/terminal/tui/src/tui/components/primitives/box.ts`
- Create: `packages/terminal/tui/src/tui/components/primitives/select-list.ts`
- Create: `packages/terminal/tui/src/tui/components/primitives/search-input.ts`
- Create: `scripts/tui-primitives.test.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`

**Interfaces:**
- Consumes: Task 1 `TuiComponent`, `FocusableComponent`, `StyledLine`, `RenderContext`, `ComponentRenderResult`, `span()`, `line()`, and existing `EditorState`/`TuiInputEvent`.
- Produces: `Text`, `VStack`, `Box`, `SelectItem`, `SelectList`, and `SearchInput`.

- [ ] **Step 1: Write failing primitive tests**

Create tests for Pi-compatible selection, scrolling, cancellation, CJK wrapping,
background fill, stack gaps, and search cursor metadata:

```ts
function keyEvent(id: KeyId): TuiInputEvent {
  return { type: "key", key: makeKeyInput(id) };
}

test("select list wraps, selects, and cancels", () => {
  const selected: string[] = [];
  let cancelled = false;
  const list = new SelectList({
    items: [
      { value: "a", label: "Alpha", description: "first" },
      { value: "b", label: "Beta", description: "second" },
    ],
    maxVisible: 5,
    onSelect: (item) => selected.push(item.value),
    onCancel: () => { cancelled = true; },
  });
  list.focused = true;
  assert.equal(list.handleInput(keyEvent("up")), true);
  assert.equal(list.selectedItem()?.value, "b");
  list.handleInput(keyEvent("enter"));
  list.handleInput(keyEvent("escape"));
  assert.deepEqual(selected, ["b"]);
  assert.equal(cancelled, true);
});

test("text wraps CJK by terminal cells", () => {
  const component = new Text({ text: "中文ab", paddingX: 0, paddingY: 0 });
  const rendered = component.render({ width: 4, theme: PI_DARK });
  assert.deepEqual(rendered.lines.map(lineText), ["中文", "ab"]);
});
```

Include a narrow-width `SelectList` assertion proving descriptions disappear
before names and a seven-item assertion proving the `(index/total)` row.

- [ ] **Step 2: Run the primitive test and verify missing exports**

Run: `node --test scripts/tui-primitives.test.ts`

Expected: FAIL because the primitive modules do not exist.

- [ ] **Step 3: Implement `Text`, `VStack`, and `Box`**

Port Pi's observable behavior to structured lines:

```ts
export class Text implements TuiComponent {
  readonly #options: {
    readonly text: string;
    readonly spans: readonly StyledSpan[];
    readonly paddingX: number;
    readonly paddingY: number;
    readonly background?: StyleToken;
  };
  #cache: { readonly width: number; readonly source: string; readonly result: ComponentRenderResult } | null = null;

  render(context: RenderContext): ComponentRenderResult {
    const spans = this.#options.spans.length > 0
      ? this.#options.spans
      : [span(this.#options.text)];
    const source = spans.map((item) => item.text).join("");
    if (this.#cache?.width === context.width && this.#cache.source === source) {
      return this.#cache.result;
    }
    const contentWidth = Math.max(1, context.width - this.#options.paddingX * 2);
    const wrapped = wrapStyledSpans(spans, contentWidth);
    const lines = applyTextPadding(wrapped, context.width, this.#options);
    const result = { lines };
    this.#cache = { width: context.width, source, result };
    return result;
  }
}
```

Define `TextOptions` in the same file:

```ts
export interface TextOptions {
  readonly text?: string;
  readonly spans?: readonly StyledSpan[];
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly background?: StyleToken;
}
```

The constructor normalizes omitted text to `""`, spans to `[]`, padding to `0`,
and rejects negative padding.

Keep padding and background application deterministic with this private helper:

```ts
function applyTextPadding(
  lines: readonly StyledLine[],
  width: number,
  options: Required<Pick<TextOptions, "paddingX" | "paddingY">>
    & Pick<TextOptions, "background">,
): readonly StyledLine[];
```

It prepends and appends exactly `paddingY` blank lines, adds exactly
`paddingX` cells on both sides of every content line, clips each result to
`width`, and fills the remaining cells with the configured background token.
When no background is configured, the remaining cells are unstyled spaces.

`VStack` concatenates child lines with an exact `gap` count. `Box` subtracts
horizontal padding before rendering its child and applies background to padding
and content spans.

- [ ] **Step 4: Implement generic `SelectList`**

Use Pi's centered visible-range calculation, selection wrapping, and responsive
description column. The public API is:

```ts
export interface SelectItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export class SelectList implements FocusableComponent {
  focused = false;
  setItems(items: readonly SelectItem[]): void;
  setFilter(filter: string): void;
  setSelectedValue(value: string): void;
  selectedItem(): SelectItem | null;
  render(context: RenderContext): ComponentRenderResult;
  handleInput(event: TuiInputEvent): boolean;
  invalidate(): void;
}
```

Selected prefix and selected text use `accent`; unselected labels have no
foreground; descriptions use `muted`; no selected background is allowed.

- [ ] **Step 5: Implement `SearchInput` using `EditorState`**

Expose value changes and cursor metadata without duplicating byte decoding:

```ts
export interface SearchInputOptions {
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly onChange?: (value: string) => void;
  readonly onSubmit?: (value: string) => void;
  readonly onCancel?: () => void;
  readonly secret?: boolean;
}
```

Map text, paste, left/right, backspace, Enter, and Escape events to existing
`EditorState` actions. Render prompt in `accent`, text with default foreground,
placeholder in `muted`, and secret text as repeated `•` characters.

- [ ] **Step 6: Run focused and repository verification**

```bash
node --test scripts/tui-primitives.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/terminal/tui/src/tui/components/primitives/text.ts packages/terminal/tui/src/tui/components/primitives/v-stack.ts packages/terminal/tui/src/tui/components/primitives/box.ts packages/terminal/tui/src/tui/components/primitives/select-list.ts packages/terminal/tui/src/tui/components/primitives/search-input.ts packages/terminal/tui/src/tui/components.ts scripts/tui-primitives.test.ts
git diff --cached --check
git commit -m "feat(tui): add component primitives"
```

---

### Task 3: Typed Transcript Blocks and Message Components

**Files:**
- Create: `packages/terminal/tui/src/tui/components/messages/user-message.ts`
- Create: `packages/terminal/tui/src/tui/components/messages/assistant-message.ts`
- Create: `packages/terminal/tui/src/tui/components/messages/thinking-message.ts`
- Create: `packages/terminal/tui/src/tui/components/messages/tool-message.ts`
- Create: `packages/terminal/tui/src/tui/components/messages/notice-message.ts`
- Create: `packages/terminal/tui/src/tui/components/messages/welcome-message.ts`
- Create: `scripts/tui-message-components.test.ts`
- Modify: `packages/terminal/tui/src/tui/transcript-store.ts`
- Modify: `packages/terminal/tui/src/tui/components/transcript.ts`
- Modify: `packages/terminal/tui/src/tui/components/tool-card.ts`
- Modify: `packages/terminal/tui/src/tui/markdown.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`
- Modify: `scripts/tui-ui.test.ts`
- Modify: `scripts/tui-markdown.test.ts`

**Interfaces:**
- Consumes: Task 1 render model/compiler, Task 2 primitives, existing `UIUpdate`, `renderMarkdownLines`, and display-policy events.
- Produces: discriminated `TranscriptBlock`, `NoticeTone`, message components, exhaustive `Transcript.renderWithMetadata()` dispatch, and typed creation helpers.

- [ ] **Step 1: Write failing typed-message tests**

Add assertions for semantic spans and every message kind:

```ts
test("assistant and input text keep terminal default foreground", () => {
  const assistant = new AssistantMessage({ text: "answer" });
  const rendered = assistant.render({ width: 40, theme: PI_DARK });
  const body = rendered.lines.flatMap((value) => value.spans);
  assert.ok(body.some((item) => item.text.includes("answer")));
  assert.ok(body.every((item) => item.style?.foreground !== "muted"));
});

test("thinking is muted italic without styling later answers", () => {
  const thinking = new ThinkingMessage({ text: "inspect" });
  const rendered = thinking.render({ width: 40, theme: PI_DARK });
  assert.ok(rendered.lines.flatMap((value) => value.spans).some((item) =>
    item.style?.foreground === "thinking" && item.style.italic === true
  ));
});

test("notice tone selects semantic style", () => {
  const warning = new NoticeMessage({ text: "blocked", tone: "warning" });
  const spans = warning.render({ width: 40, theme: PI_DARK }).lines[0]!.spans;
  assert.equal(spans[0]!.style?.foreground, "warning");
});
```

Add 40/80-column dark/light snapshots as plain arrays of `{ text, style }` so
the tests do not depend on literal ANSI bytes.

- [ ] **Step 2: Run the message test and verify missing modules**

Run: `node --test scripts/tui-message-components.test.ts`

Expected: FAIL because message modules and typed transcript variants do not
exist.

- [ ] **Step 3: Replace `TranscriptBlock` with a discriminated union**

Define exact base and mutable variants:

```ts
interface BaseTranscriptBlock {
  readonly key: string;
  mutable: boolean;
}

export type NoticeTone = "info" | "success" | "warning" | "error" | "dim";

export interface UserTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "user";
  text: string;
}

export interface AssistantTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "assistant";
  text: string;
}

export interface ThinkingTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "thinking";
  text: string;
}

export interface ToolTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "tool";
  name: string;
  subject: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  expanded: boolean;
}

export interface NoticeTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "notice";
  text: string;
  tone: NoticeTone;
}

export interface WelcomeTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "welcome";
  title: string;
  details: readonly string[];
}

export type TranscriptBlock =
  | UserTranscriptBlock
  | AssistantTranscriptBlock
  | ThinkingTranscriptBlock
  | ToolTranscriptBlock
  | NoticeTranscriptBlock
  | WelcomeTranscriptBlock;
```

Replace `createTranscriptBlock(kind, key, fields)` with named constructors such
as `createNoticeBlock()`, `createToolBlock()`, and `createAssistantBlock()` so
impossible field combinations cannot compile. Task 4 extends this closed union
with fully defined static command block types in the same edit that introduces
their view models.

Use these constructor signatures:

```ts
export function createUserBlock(key: string, text: string): UserTranscriptBlock;
export function createAssistantBlock(
  key: string,
  text?: string,
  mutable?: boolean,
): AssistantTranscriptBlock;
export function createThinkingBlock(
  key: string,
  text?: string,
  mutable?: boolean,
): ThinkingTranscriptBlock;
export function createToolBlock(
  key: string,
  fields: Pick<ToolTranscriptBlock, "name" | "subject" | "status" | "expanded">,
): ToolTranscriptBlock;
export function createNoticeBlock(
  key: string,
  text: string,
  tone?: NoticeTone,
): NoticeTranscriptBlock;
export function createWelcomeBlock(
  title: string,
  details: readonly string[],
): WelcomeTranscriptBlock;
```

Defaults are `text = ""`, `mutable = true`, and `tone = "info"`.

- [ ] **Step 4: Implement dedicated message components**

Implement one class per file. Use primitives for user background/padding and
tool background. `AssistantMessage` adapts Markdown output into structured lines
without assigning a foreground to ordinary body spans. `ToolMessage` selects:

```ts
const tone = status === "running"
  ? { background: "tool_pending_bg", title: "accent" }
  : status === "completed"
    ? { background: "tool_success_bg", title: "success" }
    : { background: "tool_error_bg", title: "warning" };
```

Render command names beginning with `$ ` through the `bash` token and render
stdout/stderr only when expanded, preserving the existing 1,200-character
display clipping behavior.

Add `renderMarkdownStyledLines(text, width)` to `markdown.ts`. Its parser emits
semantic spans for headings, code, links, emphasis, and body text; body spans
omit foreground. Keep `renderMarkdownLines(text, width, theme)` as the plain-mode
adapter implemented by compiling `renderMarkdownStyledLines()` through Task 1's
ANSI compiler.

- [ ] **Step 5: Make transcript dispatch exhaustive**

Replace the generic fallback in `Transcript.#renderBlock` with an exhaustive
switch. Use an `assertNever(value: never)` helper so a new block kind cannot
silently render as plain grey text.

- [ ] **Step 6: Update event projection and existing tests**

Map `ui.message` style inputs to typed tones at the event boundary:

```ts
function noticeTone(style: unknown): NoticeTone {
  const value = String(style ?? "");
  if (value.includes("red")) return "error";
  if (value.includes("yellow")) return "warning";
  if (value.includes("green")) return "success";
  if (value.includes("dim")) return "dim";
  return "info";
}
```

Keep this conversion only for existing runtime events. New command presenters
must pass typed tones directly.

- [ ] **Step 7: Run focused and repository verification**

```bash
node --test scripts/tui-message-components.test.ts scripts/tui-markdown.test.ts scripts/tui-ui.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add packages/terminal/tui/src/tui/components/messages/user-message.ts packages/terminal/tui/src/tui/components/messages/assistant-message.ts packages/terminal/tui/src/tui/components/messages/thinking-message.ts packages/terminal/tui/src/tui/components/messages/tool-message.ts packages/terminal/tui/src/tui/components/messages/notice-message.ts packages/terminal/tui/src/tui/components/messages/welcome-message.ts packages/terminal/tui/src/tui/transcript-store.ts packages/terminal/tui/src/tui/components/transcript.ts packages/terminal/tui/src/tui/components/tool-card.ts packages/terminal/tui/src/tui/markdown.ts packages/terminal/tui/src/tui/components.ts scripts/tui-message-components.test.ts scripts/tui-markdown.test.ts scripts/tui-ui.test.ts
git diff --cached --check
git commit -m "refactor(tui): componentize transcript messages"
```

---

### Task 4: Static Command Result Components

**Files:**
- Create: `packages/terminal/tui/src/tui/components/views/contracts.ts`
- Create: `packages/terminal/tui/src/tui/components/views/help-view.ts`
- Create: `packages/terminal/tui/src/tui/components/views/provider-status-view.ts`
- Create: `packages/terminal/tui/src/tui/components/views/queue-status-view.ts`
- Create: `scripts/tui-command-views.test.ts`
- Modify: `packages/terminal/tui/src/tui/transcript-store.ts`
- Modify: `packages/terminal/tui/src/tui/components/transcript.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`

**Interfaces:**
- Consumes: Task 1 structured text, Task 2 primitives, Task 3 typed transcript constructors.
- Produces: `HelpViewModel`, `ProviderSummaryViewModel`, `ProviderDetailViewModel`, `QueueStatusViewModel`, `HelpView`, `ProviderStatusView`, `ProviderDetailView`, and `QueueStatusView`.

- [ ] **Step 1: Define failing static-view assertions**

```ts
test("help keeps command names default and descriptions muted", () => {
  const view = new HelpView({
    commands: [{ name: "/model", usage: "/model [provider] [model]", description: "选择模型" }],
  });
  const spans = view.render({ width: 80, theme: PI_DARK }).lines.flatMap((item) => item.spans);
  const usage = spans.find((item) => item.text.includes("/model"));
  const description = spans.find((item) => item.text.includes("选择模型"));
  assert.equal(usage?.style?.foreground, undefined);
  assert.equal(description?.style?.foreground, "muted");
});

test("provider states remain independent", () => {
  const view = new ProviderStatusView({
    providers: [{
      id: "anthropic",
      name: "Anthropic",
      available: true,
      configured: true,
      verified: false,
      source: "stored credential",
    }],
  });
  assert.deepEqual(
    view.render({ width: 80, theme: PI_DARK }).lines.map(lineText),
    ["Anthropic  available  configured  unverified"],
  );
});
```

Add narrow-width assertions that stack provider state fields and queue counters
without clipping the primary label.

- [ ] **Step 2: Run the command-view test and verify missing modules**

Run: `node --test scripts/tui-command-views.test.ts`

Expected: FAIL because view contracts/components do not exist.

- [ ] **Step 3: Add UI-neutral view contracts**

Define exact immutable models in `views/contracts.ts`:

```ts
export interface HelpCommandViewModel {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

export interface ProviderSummaryViewModel {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly source: string | null;
}

export interface ProviderDetailViewModel extends ProviderSummaryViewModel {
  readonly dynamicModels: boolean;
  readonly modelCount: number;
}

export interface QueueStatusViewModel {
  readonly pending: number;
  readonly pendingTokens: number;
  readonly held: number;
  readonly heldTokens: number;
  readonly deadLetters: number;
}
```

- [ ] **Step 4: Implement static views with semantic spans**

`HelpView` uses two columns at width 50 or greater and stacked usage/description
below 50. `ProviderStatusView` renders default labels, green configured/verified,
yellow unconfigured/unverified, and muted sources. `QueueStatusView` uses default
numeric values and muted field names. No view emits ANSI.

- [ ] **Step 5: Complete static transcript variants**

Add exact transcript variants containing these view models:

```ts
export interface HelpTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "help";
  readonly commands: readonly HelpCommandViewModel[];
}

export interface ProviderListTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "provider_list";
  readonly providers: readonly ProviderSummaryViewModel[];
}

export interface ProviderDetailTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "provider_detail";
  readonly provider: ProviderDetailViewModel;
}

export interface QueueStatusTranscriptBlock extends BaseTranscriptBlock {
  readonly kind: "queue_status";
  readonly queue: QueueStatusViewModel;
}
```

Extend `TranscriptBlock` with these four interfaces and update transcript
dispatch so each static command block instantiates its dedicated component.

- [ ] **Step 6: Run focused and repository verification**

```bash
node --test scripts/tui-command-views.test.ts scripts/tui-message-components.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/terminal/tui/src/tui/components/views/contracts.ts packages/terminal/tui/src/tui/components/views/help-view.ts packages/terminal/tui/src/tui/components/views/provider-status-view.ts packages/terminal/tui/src/tui/components/views/queue-status-view.ts packages/terminal/tui/src/tui/transcript-store.ts packages/terminal/tui/src/tui/components/transcript.ts packages/terminal/tui/src/tui/components.ts scripts/tui-command-views.test.ts
git diff --cached --check
git commit -m "feat(tui): add command result components"
```

---

### Task 5: Interactive Selector and Authentication Components

**Files:**
- Create: `packages/terminal/tui/src/tui/components/views/model-selector.ts`
- Create: `packages/terminal/tui/src/tui/components/views/effort-selector.ts`
- Create: `packages/terminal/tui/src/tui/components/views/auth-dialog.ts`
- Modify: `packages/terminal/tui/src/tui/components/views/contracts.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`
- Modify: `scripts/tui-command-views.test.ts`

**Interfaces:**
- Consumes: Task 2 `SearchInput`, `SelectList`, `Box`, `VStack`; Task 4 view contracts.
- Produces: `SelectionRequest`, `PromptRequest`, `ModelSelectorView`, `EffortSelectorView`, `ProviderSelectorView`, and `AuthDialog`.

- [ ] **Step 1: Add failing interaction tests**

```ts
function keyEvent(id: KeyId): TuiInputEvent {
  return { type: "key", key: makeKeyInput(id) };
}

test("model selector filters and returns the highlighted model", () => {
  const selections: string[] = [];
  const view = new ModelSelectorView({
    title: "Models",
    currentValue: "deepseek/deepseek-v4-flash",
    items: [
      { value: "deepseek/deepseek-v4-flash", label: "deepseek-v4-flash", description: "DeepSeek" },
      { value: "anthropic/claude-sonnet", label: "claude-sonnet", description: "Anthropic" },
    ],
    onSelect: (value) => selections.push(value),
    onCancel: () => {},
  });
  view.focused = true;
  view.handleInput({ type: "text", text: "clau" });
  view.handleInput(keyEvent("enter"));
  assert.deepEqual(selections, ["anthropic/claude-sonnet"]);
});

test("auth dialog masks secret input and never renders the value", () => {
  const view = new AuthDialog({
    request: { kind: "secret", message: "Enter API key" },
    onSubmit: () => {},
    onCancel: () => {},
  });
  view.focused = true;
  view.handleInput({ type: "text", text: "secret-value" });
  const output = view.render({ width: 60, theme: PI_DARK }).lines.map(lineText).join("\n");
  assert.equal(output.includes("secret-value"), false);
  assert.equal(output.includes("••••••••••••"), true);
});
```

Add tests for effort current selection, provider selection, Escape, Ctrl+C, no
matching model, and a select-type authentication request.

- [ ] **Step 2: Run tests and verify missing view failures**

Run: `node --test scripts/tui-command-views.test.ts`

Expected: FAIL because interactive view classes do not exist.

- [ ] **Step 3: Define generic interaction request types**

```ts
export interface SelectionRequest {
  readonly id: string;
  readonly title: string;
  readonly items: readonly SelectItem[];
  readonly currentValue?: string;
  readonly searchable?: boolean;
  readonly maxVisible?: number;
}

export type PromptRequest =
  | { readonly id: string; readonly kind: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly id: string; readonly kind: "secret"; readonly message: string; readonly placeholder?: string }
  | { readonly id: string; readonly kind: "select"; readonly message: string; readonly items: readonly SelectItem[] };
```

- [ ] **Step 4: Implement selector compositions**

`ModelSelectorView` composes title, searchable input, `SelectList`, selected
details, and scroll information. `EffortSelectorView` and
`ProviderSelectorView` are thin `SelectList` compositions but remain named
business components. All selectors implement `FocusableComponent` and forward
focus to their active child.

- [ ] **Step 5: Implement `AuthDialog`**

Use `Box` with `card` background, title in accent, message in default foreground,
and hint in dim. Text/secret requests use `SearchInput`; select requests use
`SelectList`. The submitted value is passed directly to the callback and is not
stored after completion. `invalidate()` clears cached render data but does not
expose the input value.

- [ ] **Step 6: Run focused and repository verification**

```bash
node --test scripts/tui-command-views.test.ts scripts/tui-primitives.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/terminal/tui/src/tui/components/views/model-selector.ts packages/terminal/tui/src/tui/components/views/effort-selector.ts packages/terminal/tui/src/tui/components/views/auth-dialog.ts packages/terminal/tui/src/tui/components/views/contracts.ts packages/terminal/tui/src/tui/components.ts scripts/tui-command-views.test.ts
git diff --cached --check
git commit -m "feat(tui): add interactive command views"
```

---

### Task 6: Focused View Host and Loop Input Routing

**Files:**
- Create: `packages/terminal/tui/src/tui/view-host.ts`
- Modify: `packages/terminal/tui/src/tui/overlay-manager.ts`
- Modify: `packages/terminal/tui/src/tui/focus-manager.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`
- Modify: `packages/terminal/tui/src/tui/ui.ts`
- Modify: `scripts/overlay-focus.test.ts`
- Modify: `scripts/tui-ui.test.ts`

**Interfaces:**
- Consumes: Task 5 request/view classes, existing `InteractiveTerminalLoop` work queue and normalized `TuiInputEvent`.
- Produces: component-owning `OverlayEntry`, `ViewHost`, `TerminalUI.select(request)`, `TerminalUI.prompt(request)`, and loop work item types for opening/closing views.

- [ ] **Step 1: Write failing view-host lifecycle tests**

```ts
test("selector receives input before composer and restores focus on submit", async () => {
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  const submitted: string[] = [];
  ui.startLoop((text) => submitted.push(text));

  const selection = ui.select({
    id: "effort",
    title: "Reasoning effort",
    items: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
    currentValue: "low",
  });
  ui.drainLoop();
  ui.feedInputBytes(Buffer.from("\x1b[B\r"));
  ui.drainLoop();

  assert.equal(await selection, "high");
  assert.deepEqual(submitted, []);
  assert.equal(ui.focusedComponentId(), "composer");
});
```

Add cancellation, modal-over-selector priority, closed-loop cancellation, and
secret value absence from `MemoryTerminalDriver.writes` tests.

- [ ] **Step 2: Run focused tests and verify missing APIs**

Run: `node --test scripts/overlay-focus.test.ts scripts/tui-ui.test.ts`

Expected: FAIL because overlays do not own components and `TerminalUI.select`
does not exist.

- [ ] **Step 3: Make overlays own focused components**

Change the entry contract to:

```ts
export interface OverlayEntry {
  readonly id: string;
  readonly priority: OverlayPriority;
  readonly placement: "dock";
  readonly component: FocusableComponent;
}
```

When an entry becomes topmost, set its component `focused = true` and set the
previous component `focused = false`. Closing topmost restores focus to the next
overlay or the composer.

- [ ] **Step 4: Implement `ViewHost` Promise ownership**

```ts
interface ActiveView<T> {
  readonly id: string;
  readonly component: FocusableComponent;
  readonly resolve: (value: T | null) => void;
}

export class ViewHost {
  openSelection(request: SelectionRequest): Promise<string | null>;
  openPrompt(request: PromptRequest): Promise<string | null>;
  handleInput(event: TuiInputEvent): boolean;
  render(context: RenderContext): ComponentRenderResult;
  closeActive(value: string | null): void;
  closeAll(): void;
  activeId(): string | null;
}
```

Resolve each Promise exactly once. Clear secret input before resolving or
cancelling. Reject duplicate ids by closing the previous view with `null`.

- [ ] **Step 5: Add view work items and input priority to the loop**

Extend `LoopWorkItem` with typed `open_selection`, `open_prompt`, and
`close_view` variants. Route input in this order:

```ts
if (this.#ui.handleActiveViewInput(event)) {
  this.#needsRender = true;
  return;
}
// Existing global keybinding and editor routing follows.
```

The loop remains the only place that mutates view focus while running.

- [ ] **Step 6: Expose generic TerminalUI view methods**

`TerminalUI.select()` and `prompt()` delegate to `ViewHost` through queued work.
Use overloads during migration:

```ts
prompt(request: PromptRequest): Promise<string | null>;
prompt(message: string): Promise<string>;
prompt(request: PromptRequest | string): Promise<string | null> {
  const normalized = typeof request === "string"
    ? { id: "legacy-text-prompt", kind: "text" as const, message: request }
    : request;
  return this.#viewHost.openPrompt(normalized);
}
```

Keep `promptSecret(message)` as a named wrapper that creates a `secret` request.
Task 10 updates every caller and removes the string overload and wrapper.

- [ ] **Step 7: Run focused and repository verification**

```bash
node --test scripts/overlay-focus.test.ts scripts/tui-ui.test.ts scripts/tui-command-views.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 8: Commit Task 6**

```bash
git add packages/terminal/tui/src/tui/view-host.ts packages/terminal/tui/src/tui/overlay-manager.ts packages/terminal/tui/src/tui/focus-manager.ts packages/terminal/tui/src/tui/components.ts packages/terminal/tui/src/tui/ui.ts scripts/overlay-focus.test.ts scripts/tui-ui.test.ts
git diff --cached --check
git commit -m "feat(tui): host focused interactive views"
```

---

### Task 7: Unframed Main Screen, Composer, Completion, and Status

**Files:**
- Create: `packages/terminal/tui/src/tui/main-screen.ts`
- Create: `packages/terminal/tui/src/tui/components/composer.ts`
- Create: `packages/terminal/tui/src/tui/components/status-line.ts`
- Modify: `packages/terminal/tui/src/tui/components/completion-list.ts`
- Modify: `packages/terminal/tui/src/tui/component.ts`
- Modify: `packages/terminal/tui/src/tui/contracts.ts`
- Modify: `packages/terminal/tui/src/tui/editor.ts`
- Modify: `packages/terminal/tui/src/tui/frame-builder.ts`
- Modify: `packages/terminal/tui/src/tui/ui.ts`
- Modify: `packages/terminal/tui/src/tui/components.ts`
- Modify: `scripts/frame-builder.test.ts`
- Modify: `scripts/tui-ui.test.ts`
- Modify: `scripts/tui-screen.test.ts`

**Interfaces:**
- Consumes: Tasks 1-6 components/compiler/view host; existing editor render metadata and `PiMainScreenRenderer` `ScreenFrame` contract.
- Produces: `MainScreen`, unframed `FrameBuilder.build()`, structured `CompletionPopup`, and structured `StatusLine`.

- [ ] **Step 1: Write failing unframed-layout tests**

```ts
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/gu, "");
}

test("main screen has no global decorative frame", () => {
  const state = createUIState();
  const transcript = new TranscriptStore();
  transcript.append(createAssistantBlock("answer-1", "answer", false));
  const editor = new EditorState();
  editor.text = "abc";
  editor.cursor = 3;
  const frame = new FrameBuilder({ state, transcript }).build({ width: 40, editor });
  assert.equal(frame.screen.lines.some((value) => /[╭╮╰╯│]/u.test(stripAnsi(value))), false);
  assert.ok(frame.screen.lines.some((value) => stripAnsi(value).includes("answer")));
  assert.ok(frame.screen.lines.some((value) => stripAnsi(value).includes("❯ abc")));
});

test("completion height follows actual candidates", () => {
  const popup = new CompletionPopup({
    items: [
      { value: "/help", description: "查看帮助", start: 0 },
      { value: "/model", description: "选择模型", start: 0 },
    ],
    selectedIndex: 0,
  });
  assert.equal(popup.render({ width: 40, theme: PI_DARK }).lines.length, 2);
});
```

Add terminal-emulator assertions for completion shrink, three-character typing,
CJK cursor column, and selector close without duplicate prompt rows.

- [ ] **Step 2: Run focused tests and verify current frame assertions fail**

Run: `node --test scripts/frame-builder.test.ts scripts/tui-ui.test.ts scripts/tui-screen.test.ts`

Expected: FAIL because `FrameBuilder` still emits the global frame and fixed
separator rows.

- [ ] **Step 3: Migrate completion to structured selection styling**

Rename the visible business component to `CompletionPopup` while preserving a
compatibility export `CompletionList`. Render unselected names with no foreground,
descriptions as `muted`, and the selected prefix/name as `accent`. Use only the
actual candidate count up to six rows.

After `CompletionPopup` implements `TuiComponent`, remove
`LegacyTuiComponent` from `component.ts` and verify no imports remain with:

```bash
rg -n "LegacyTuiComponent" packages/terminal/tui/src scripts
```

Expected: no matches.

- [ ] **Step 4: Add structured editor projection and `Composer`**

Extend `EditorLike` and `EditorState` with a projection that reuses the existing
text, cursor, history, completion, and terminal-cell calculations:

```ts
renderStyledLines(
  width: number,
  options: { readonly prompt: string; readonly mask: boolean },
): {
  readonly lines: readonly StyledLine[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
};
```

`Composer` delegates to this method, styles only the prompt as `accent`, leaves
typed text uncolored, and reports the same cursor metadata in
`ComponentRenderResult`. Add an editor regression asserting `中文abc` places the
cursor after nine cells in the unframed editor.

- [ ] **Step 5: Implement `MainScreen`**

Compose logical sections without global border:

```ts
const dock = activeView !== null
  ? activeView.render(context)
  : composer.render(context);
const lines = [
  ...transcript.lines,
  ...dock.lines,
  ...completion.lines,
  ...status.lines,
];
```

Use explicit one-line gaps only where transcript block boundaries require them.
Cursor row is `transcript.lines.length + dock.cursor.row`; cursor column is the
dock cursor column. `activeStart` is the first mutable transcript line or the
start of the dock.

- [ ] **Step 6: Replace hard-coded frame assembly**

Delete `rule()` and `frameLine()` from `frame-builder.ts`. `FrameBuilder` now
accepts compiled main-screen lines and returns the existing `ScreenFrame` shape.
Keep every final visible line at or below terminal width and preserve the
renderer final-column safety rule.

- [ ] **Step 7: Implement responsive `StatusLine`**

Render cwd/queue/tokens on the left and provider/model/effort on the right when
both fit. Drop cwd first, then token details, before truncating provider/model.
Metadata uses `dim`; provider/model uses terminal default foreground.

- [ ] **Step 8: Run focused and repository verification**

```bash
node --test scripts/frame-builder.test.ts scripts/tui-editor.test.ts scripts/tui-ui.test.ts scripts/tui-screen.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS and existing native-scrollback tests remain green.

- [ ] **Step 9: Commit Task 7**

```bash
git add packages/terminal/tui/src/tui/main-screen.ts packages/terminal/tui/src/tui/components/composer.ts packages/terminal/tui/src/tui/components/status-line.ts packages/terminal/tui/src/tui/components/completion-list.ts packages/terminal/tui/src/tui/component.ts packages/terminal/tui/src/tui/contracts.ts packages/terminal/tui/src/tui/editor.ts packages/terminal/tui/src/tui/frame-builder.ts packages/terminal/tui/src/tui/ui.ts packages/terminal/tui/src/tui/components.ts scripts/frame-builder.test.ts scripts/tui-editor.test.ts scripts/tui-ui.test.ts scripts/tui-screen.test.ts
git diff --cached --check
git commit -m "refactor(tui): compose unframed main screen"
```

---

### Task 8: Command Presentation Port and Plain/Terminal Adapters

**Files:**
- Create: `apps/cli/src/command-presentation.ts`
- Create: `apps/cli/src/plain-command-presenter.ts`
- Create: `apps/cli/src/terminal-command-presenter.ts`
- Create: `scripts/command-presentation.test.ts`
- Create: `scripts/helpers/command-presentation-fixture.ts`
- Modify: `packages/terminal/tui/src/index.ts`
- Modify: `apps/cli/src/main.ts`

**Interfaces:**
- Consumes: Task 4 static view models/blocks, Task 5 selection/prompt requests, Task 6 `TerminalUI.select/prompt`, Task 7 main-screen integration.
- Produces: `CommandPresenter`, presentation models, `PlainCommandPresenter`, and `TerminalCommandPresenter`.

- [ ] **Step 1: Write failing presenter-equivalence tests**

```ts
export class RecordingPresenter implements CommandPresenter {
  readonly notices: NoticePresentation[] = [];
  readonly helpViews: HelpPresentation[] = [];
  readonly providerViews: ProviderListPresentation[] = [];
  readonly providerDetails: ProviderDetailPresentation[] = [];
  readonly queueViews: QueuePresentation[] = [];
  readonly selections: SelectionPresentation[] = [];
  readonly promptRequests: PromptPresentation[] = [];
  readonly #selectionAnswers: string[];
  readonly #promptAnswers: string[];

  constructor(options: {
    readonly selections?: readonly string[];
    readonly prompts?: readonly string[];
  } = {}) {
    this.#selectionAnswers = [...(options.selections ?? [])];
    this.#promptAnswers = [...(options.prompts ?? [])];
  }

  notice(value: NoticePresentation): void { this.notices.push(value); }
  help(value: HelpPresentation): void { this.helpViews.push(value); }
  providers(value: ProviderListPresentation): void { this.providerViews.push(value); }
  providerDetail(value: ProviderDetailPresentation): void { this.providerDetails.push(value); }
  queue(value: QueuePresentation): void { this.queueViews.push(value); }
  async select(value: SelectionPresentation): Promise<string | null> {
    this.selections.push(value);
    return this.#selectionAnswers.shift() ?? null;
  }
  async prompt(value: PromptPresentation): Promise<string | null> {
    this.promptRequests.push(value);
    return this.#promptAnswers.shift() ?? null;
  }
}

test("plain presenter formats the same help facts", () => {
  const output: string[] = [];
  const presenter = new PlainCommandPresenter({
    output: (value) => output.push(value),
    input: async () => "",
    secretInput: async () => "",
  });
  presenter.help({ commands: [{ name: "/help", usage: "/help", description: "查看命令帮助" }] });
  assert.deepEqual(output, ["Commands:", "  /help  查看命令帮助"]);
});
```

Add terminal presenter tests proving `help` appends a `help` transcript block,
`select` delegates to `TerminalUI.select`, and a secret prompt value is returned
without being appended.

Place `RecordingPresenter` in
`scripts/helpers/command-presentation-fixture.ts` and import it from command,
model-selection, provider-auth, and integration tests.

- [ ] **Step 2: Run the presenter test and verify missing modules**

Run: `node --test scripts/command-presentation.test.ts`

Expected: FAIL because presentation ports/adapters do not exist.

- [ ] **Step 3: Define the presentation port**

Create immutable application-level models and this exact interface:

```ts
export interface NoticePresentation {
  readonly text: string;
  readonly tone: NoticeTone;
}

export interface HelpPresentation {
  readonly commands: readonly HelpCommandViewModel[];
}

export interface ProviderListPresentation {
  readonly providers: readonly ProviderSummaryViewModel[];
}

export interface ProviderDetailPresentation {
  readonly provider: ProviderDetailViewModel;
}

export interface QueuePresentation {
  readonly queue: QueueStatusViewModel;
}

export type SelectionPresentation = SelectionRequest;
export type PromptPresentation = PromptRequest;

export interface CommandPresenter {
  notice(message: NoticePresentation): void;
  help(view: HelpPresentation): void;
  providers(view: ProviderListPresentation): void;
  providerDetail(view: ProviderDetailPresentation): void;
  queue(view: QueuePresentation): void;
  select(request: SelectionPresentation): Promise<string | null>;
  prompt(request: PromptPresentation): Promise<string | null>;
}
```

Presentation models use booleans and numbers, never precolored strings.

- [ ] **Step 4: Implement `PlainCommandPresenter`**

Format each model as deterministic plain lines. Numbered options are allowed
only here because non-interactive input has no focused selector. Secret prompts
call the injected `secretInput` and never call `output` with the answer.

- [ ] **Step 5: Implement `TerminalCommandPresenter`**

Map notices/static views to typed transcript constructors and interactive
requests to `TerminalUI.select()`/`prompt()`. Do not call
`runtime.publishNotice`; the UI loop owns rendering directly.

- [ ] **Step 6: Wire presenters in `main.ts`**

Construct exactly one presenter:

```ts
const commandPresenter: CommandPresenter = terminalUi === null
  ? new PlainCommandPresenter({ output: outputFn, input: selectorInput, secretInput: authSecretInput })
  : new TerminalCommandPresenter(terminalUi);
```

Pass it to `SessionCommands`, model setup flow, and provider authentication.
Preserve `PlainEventSink` for runtime events.

- [ ] **Step 7: Run focused and repository verification**

```bash
node --test scripts/command-presentation.test.ts scripts/cli.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 8: Commit Task 8**

```bash
git add apps/cli/src/command-presentation.ts apps/cli/src/plain-command-presenter.ts apps/cli/src/terminal-command-presenter.ts packages/terminal/tui/src/index.ts apps/cli/src/main.ts scripts/command-presentation.test.ts scripts/helpers/command-presentation-fixture.ts
git diff --cached --check
git commit -m "refactor(cli): add command presentation boundary"
```

---

### Task 9: Componentized Model and Effort Flows

**Files:**
- Modify: `apps/cli/src/model-selection.ts`
- Modify: `apps/cli/src/commands.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `scripts/model-selection.test.ts`
- Modify: `scripts/commands.test.ts`
- Create: `scripts/helpers/session-command-fixture.ts`
- Modify: `scripts/command-presentation.test.ts`
- Modify: `scripts/tui-ui.test.ts`

**Interfaces:**
- Consumes: Task 8 `CommandPresenter`; existing `ModelCatalog`, `ModelInfo`, `ModelProviderInfo`, `ReasoningEffort`, and agent model-switch methods.
- Produces: UI-neutral `ModelSelector.listProviders()`, `listModels()`, `selectExact()`, presenter-driven `/model`, and presenter-driven `/effort`.

- [ ] **Step 1: Replace string-output tests with presentation assertions**

Update the command test fixture to inject `RecordingPresenter`. Add:

```ts
test("model command opens searchable component requests", async () => {
  const presenter = new RecordingPresenter({ selections: ["deepseek", "deepseek-v4-pro"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });
  const result = await commands.execute("/model");
  assert.equal(result.status, "handled");
  assert.equal(presenter.selections[0]?.id, "model-provider");
  assert.equal(presenter.selections[1]?.id, "model-name");
  assert.equal(presenter.selections[1]?.searchable, true);
  assert.equal(agent.model, "deepseek-v4-pro");
});

test("effort command selects only supported values", async () => {
  const presenter = new RecordingPresenter({ selections: ["medium"] });
  const { commands, agent } = createSessionCommandFixture({ presenter });
  await commands.execute("/effort");
  assert.deepEqual(
    presenter.selections[0]?.items.map((item) => item.value),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.equal(agent.reasoningEffort, "medium");
});
```

Move the current `FakeCatalog`, `FakeAgent`, fake auth/session types, and
command-fixture construction from `scripts/commands.test.ts` into
`scripts/helpers/session-command-fixture.ts`. Export this stable contract:

```ts
export interface SessionCommandFixtureOptions {
  readonly presenter: CommandPresenter;
  readonly providers?: readonly ModelProviderInfo[];
  readonly configured?: ReadonlySet<string>;
  readonly ambientSources?: ReadonlyMap<string, string>;
  readonly agent?: FakeAgent;
  readonly session?: SessionLike | null;
}

export interface SessionCommandFixture {
  readonly commands: SessionCommands;
  readonly agent: FakeAgent;
  readonly auth: FakeProviderAuth;
  readonly catalog: FakeCatalog;
}

export function createSessionCommandFixture(
  options: SessionCommandFixtureOptions,
): SessionCommandFixture;
```

The exported fakes retain the existing model/provider fixtures and never call a
network service.

- [ ] **Step 2: Run focused tests and confirm they fail on current output API**

Run: `node --test scripts/model-selection.test.ts scripts/commands.test.ts`

Expected: FAIL because `SessionCommands` still takes `input`/`output` and
`ModelSelector` still owns numbered prompts.

- [ ] **Step 3: Make `ModelSelector` UI-neutral**

Replace prompt/output ownership with:

```ts
listProviders(): readonly ModelProviderInfo[] {
  return this.#catalog.listProviders();
}

async listModels(provider: string, query: string): Promise<readonly ModelInfo[]> {
  await this.#catalog.refresh(provider);
  return filterModels(await this.#catalog.listAvailableModels(provider), query, 20);
}

async selectExact(options: {
  providerName: string;
  modelName: string;
  promptForMissingKey: boolean;
  authPrompts?: AuthPromptHandler;
}): Promise<ModelSelection | null> {
  const provider = this.#catalog.getProvider(options.providerName);
  if (provider === undefined) {
    throw new Error(`Unknown provider: ${options.providerName}`);
  }
  const configured = await this.#providerAuth.ensureConfigured(
    options.providerName,
    {
      promptIfMissing: options.promptForMissingKey,
      prompts: options.authPrompts,
    },
  );
  if (!configured) {
    return null;
  }
  await this.#catalog.refresh(options.providerName);
  const available = await this.#catalog.listAvailableModels(options.providerName);
  const selected = available.find((model) => model.id === options.modelName)
    ?? this.#catalog.getModel(options.providerName, options.modelName);
  if (selected === undefined) {
    throw new Error(`Unknown model: ${options.providerName}/${options.modelName}`);
  }
  return {
    config: {
      provider: options.providerName,
      model: selected.id,
      baseUrl: null,
    },
  };
}
```

Keep startup selection in a named `runInitialModelSelection()` function using
`PlainCommandPresenter`; it must call the same `listProviders`, `listModels`, and
`selectExact` methods and pass an `AuthPromptHandler` backed by
`PlainCommandPresenter.prompt`. Session `/model` passes
`promptForMissingKey: false` and omits `authPrompts`.

- [ ] **Step 4: Rewrite `/model` around presentation requests**

With no arguments, select provider then model. With provider only, select a
model. With provider/model, validate directly. `current` emits a typed info
notice. Model options use `provider/model` as stable values and model name/provider
as label/description fields. Keep `promptForMissingKey: false` in session mode.

- [ ] **Step 5: Rewrite `/effort` around `SelectionPresentation`**

Use supported values as `SelectItem`s, set `currentValue`, and set the chosen
effort only after a non-null selection. Direct valid arguments still work and
emit success/error notices. Preserve automatic effort clamping after model
switch.

- [ ] **Step 6: Add persistent-loop integration assertions**

Execute `/model` and `/effort` through the command dispatcher while a memory UI
loop is running. Assert selector text appears, numbered prompt text does not,
Enter changes state, and Escape leaves state unchanged.

- [ ] **Step 7: Run focused and repository verification**

```bash
node --test scripts/model-selection.test.ts scripts/commands.test.ts scripts/command-presentation.test.ts scripts/tui-ui.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 8: Commit Task 9**

```bash
git add apps/cli/src/model-selection.ts apps/cli/src/commands.ts apps/cli/src/main.ts scripts/model-selection.test.ts scripts/commands.test.ts scripts/helpers/session-command-fixture.ts scripts/command-presentation.test.ts scripts/tui-ui.test.ts
git diff --cached --check
git commit -m "feat(tui): componentize model and effort commands"
```

---

### Task 10: Componentized Authentication, Provider, Help, Queue, and Notices

**Files:**
- Modify: `apps/cli/src/provider-auth.ts`
- Modify: `apps/cli/src/commands.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/repl.ts`
- Modify: `packages/terminal/tui/src/tui/display-actions.ts`
- Modify: `scripts/provider-auth.test.ts`
- Modify: `scripts/commands.test.ts`
- Modify: `scripts/command-presentation.test.ts`
- Modify: `scripts/tui-ui.test.ts`
- Modify: `scripts/workspace-architecture.test.ts`

**Interfaces:**
- Consumes: Task 8 presenter, Task 9 command constructor shape, existing `ModelAuthService` and `ApiKeySetupInteraction`.
- Produces: prompt-injected `ProviderAuthController`, componentized `/login`, `/logout`, `/apikey`, `/providers`, `/help`, `/queue`, `/cancel`, `/clear`, blocked/unknown/error notices, and no command string-list output.

- [ ] **Step 1: Add failing authentication and remaining-command tests**

```ts
test("login routes secret prompts through presenter", async () => {
  const presenter = new RecordingPresenter({ prompts: ["api-secret"] });
  const auth = new FakeAuthService(async (interaction) => {
    assert.equal(await interaction.prompt({
      type: "secret",
      message: "Enter API key",
    }), "api-secret");
    return { configured: true, source: "stored credential" };
  });
  const prompts: AuthPromptHandler = {
    prompt: (request) => presenter.prompt({
      id: "auth-deepseek",
      kind: request.kind,
      message: request.message,
      ...(request.kind === "select"
        ? {
            items: (request.options ?? []).map((item) => ({
              value: item.id,
              label: item.label,
              description: item.description,
            })),
          }
        : {}),
    } as PromptPresentation),
  };
  const controller = new ProviderAuthController({ auth });
  const status = await controller.login("deepseek", prompts);
  assert.equal(status?.configured, true);
  assert.equal(presenter.promptRequests[0]?.kind, "secret");
  assert.equal(JSON.stringify(presenter).includes("api-secret"), false);
});

test("help emits a structured help model", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });
  await commands.execute("/help");
  assert.ok(presenter.helpViews[0]?.commands.some((item) => item.name === "/model"));
  assert.equal(presenter.notices.some((item) => item.text === "Commands:"), false);
});

test("providers emit typed independent states", async () => {
  const presenter = new RecordingPresenter();
  const { commands } = createSessionCommandFixture({ presenter });
  await commands.execute("/providers");
  assert.deepEqual(presenter.providerViews[0]?.providers[0], {
    id: "anthropic",
    name: "Anthropic",
    available: true,
    configured: true,
    verified: false,
    source: "stored credential",
  });
});
```

Add tests for auth select/text prompts, cancellation, service failure, ambient
credentials after logout, `/apikey` aliases, queue fields, clear/cancel success,
blocked commands, unknown suggestions, rejected messages, and shutdown errors.

- [ ] **Step 2: Run focused tests and verify current string-output failures**

Run: `node --test scripts/provider-auth.test.ts scripts/commands.test.ts scripts/tui-ui.test.ts`

Expected: FAIL because authentication and remaining commands still use input and
output callbacks.

- [ ] **Step 3: Refactor `ProviderAuthController` prompt ownership**

Define:

```ts
export interface AuthPromptHandler {
  prompt(request: {
    readonly kind: "text" | "secret" | "select";
    readonly message: string;
    readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  }): Promise<string | null>;
}
```

`login(provider, prompts)` adapts `ApiKeySetupInteraction.prompt` to this handler.
A `null` answer throws an internal cancellation marker caught by the controller
and returns `null`. Service errors propagate as typed failures to the caller;
the controller does not print.

Retain `ensureConfigured` with this explicit signature:

```ts
ensureConfigured(provider: string, options: {
  readonly promptIfMissing: boolean;
  readonly prompts?: AuthPromptHandler;
}): Promise<boolean>;
```

When credentials are missing and `promptIfMissing` is false, return false. When
it is true, require `prompts`, call `login(provider, prompts)`, and return whether
the resulting status is configured.

- [ ] **Step 4: Componentize provider and credential commands**

Use presenter selection when provider is omitted. `/providers` gathers all
statuses concurrently, maps separate booleans and source, and calls
`presenter.providers()`. Provider detail calls `presenter.providerDetail()`.
Login/logout results use success/warning/error notices. `/apikey` delegates to
the same handlers without adding compatibility-only text output.

- [ ] **Step 5: Componentize help and queue**

`/help` passes sorted registry specs to `presenter.help()`. `/queue` passes raw
queue counts to `presenter.queue()`; `resume` and `clear` emit typed success
notices. No command handler calls `.padEnd()` for terminal layout.

- [ ] **Step 6: Componentize all remaining notices**

Replace command and REPL calls that publish formatted `ui.message` strings with
typed presenter notices where the source is a local command/UI action. Runtime
events remain event-bus driven. Map these tones exactly:

```ts
const tones = {
  blocked: "warning",
  cancelled: "warning",
  cleared: "success",
  switched: "success",
  invalid: "error",
  unknown: "info",
} as const;
```

Remove `DisplayAction` variants `text`, `status`, and `error` after all callers
use components; retain local toggle/clear/exit actions.

- [ ] **Step 7: Prove interactive command output no longer uses string lists**

Add a source-level architecture assertion to `scripts/workspace-architecture.test.ts`:

```ts
const commands = readFileSync("apps/cli/src/commands.ts", "utf8");
assert.equal(commands.includes("readonly #output"), false);
assert.equal(commands.includes("readonly #input"), false);
assert.equal(commands.includes("this.#output("), false);
```

Also assert `model-selection.ts` and `provider-auth.ts` contain no `console.log`
and no numbered-list formatting.

- [ ] **Step 8: Run focused and repository verification**

```bash
node --test scripts/provider-auth.test.ts scripts/commands.test.ts scripts/command-presentation.test.ts scripts/tui-ui.test.ts scripts/workspace-architecture.test.ts
npm run build
npm test
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 9: Commit Task 10**

```bash
git add apps/cli/src/provider-auth.ts apps/cli/src/commands.ts apps/cli/src/main.ts apps/cli/src/repl.ts packages/terminal/tui/src/tui/display-actions.ts scripts/provider-auth.test.ts scripts/commands.test.ts scripts/command-presentation.test.ts scripts/tui-ui.test.ts scripts/workspace-architecture.test.ts
git diff --cached --check
git commit -m "refactor(tui): componentize session commands"
```

---

### Task 11: Full Integration, Visual Regression, and Real-Terminal Verification

**Files:**
- Modify: `scripts/tui-smoke.sh`
- Modify: `scripts/tui-ui.test.ts`
- Modify: `scripts/tui-screen.test.ts`
- Modify: `scripts/helpers/terminal-emulator.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-27-tui-component-system-design.md`
- Modify: `docs/superpowers/plans/2026-08-27-tui-component-system.md`

**Interfaces:**
- Consumes: complete Tasks 1-10 implementation.
- Produces: end-to-end acceptance evidence for all current commands, terminal semantics, styles, secrets, and plain-mode compatibility.

- [ ] **Step 1: Add end-to-end terminal-emulator scenarios**

Add one deterministic scenario per contract group:

```ts
test("interactive command component journey preserves scrollback and cursor", async () => {
  const driver = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const terminal = new TerminalEmulator({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ theme: "dark", driver });
  const presenter = new TerminalCommandPresenter(ui);
  const { commands } = createSessionCommandFixture({ presenter });
  ui.setCommandRegistry(commands.registry);
  ui.startLoop((text) => { void commands.execute(text); });

  async function type(value: string): Promise<void> {
    ui.feedInputBytes(Buffer.from(value));
    ui.drainLoop();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    ui.drainLoop();
    terminal.write(driver.writes());
    driver.clearWrites();
  }

  await type("/help\r");
  await type("/model\r");
  await type("deep\r");
  await type("\x1b[B\r");
  await type("/effort\r\x1b[B\r");
  await type("中文abc");

  const screen = terminal.logicalLines.join("\n");
  assert.ok(screen.includes("/model [provider] [model]"));
  assert.equal(screen.includes("Model providers:\n  1."), false);
  assert.equal(screen.split("❯ 中文abc").length - 1, 1);
  assert.equal(terminal.cursorColumn, visibleWidth("❯ 中文abc"));
});
```

Use fake catalog/auth/tool fixtures only. Add completion shrink, selector Escape,
resize, reasoning-to-answer freeze, tool expand/collapse, and second-turn native
scrollback assertions.

- [ ] **Step 2: Add dark/light structured style snapshots**

For widths 40 and 80, snapshot `HelpView`, `ProviderStatusView`,
`ModelSelectorView`, `EffortSelectorView`, `AuthDialog`, `ThinkingMessage`, and
`ToolMessage` as arrays of span text plus semantic tokens. Assert ordinary input
and answer spans have no foreground token.

- [ ] **Step 3: Extend the package smoke test**

Update `scripts/tui-smoke.sh` to start the built CLI in tmux without provider
calls, open slash completion/help, type three characters, dismiss with Escape,
and capture the pane. Fail on global frame glyphs, numbered interactive model
lists, duplicated prompts, or literal terminal negotiation fragments.

- [ ] **Step 4: Document exact manual verification**

Add a README section with these commands and observations:

```bash
npm run build
tmux new-session -d -s laohuang-component-test -x 80 -y 24
tmux send-keys -t laohuang-component-test "node apps/cli/dist/bin.js" Enter
tmux send-keys -t laohuang-component-test "/help" Enter
tmux capture-pane -t laohuang-component-test -p
tmux send-keys -t laohuang-component-test Escape
tmux kill-session -t laohuang-component-test
```

Record that provider-backed model/auth actions require configured credentials
and are not part of automated smoke verification.

- [ ] **Step 5: Run the complete automated acceptance suite**

```bash
npm run build
npm test
npm run smoke:tui
git diff --check
```

Expected: all commands PASS without real credentials.

- [ ] **Step 6: Run the controlled tmux checklist**

Build first, then exercise `/`, `/help`, `/model`, `/effort`, `/providers`, three
ASCII characters, CJK input, Escape, terminal resize, reasoning display, and a
fake/local tool display. Capture the pane after each surface and verify:

- no global frame;
- no all-grey command/provider list;
- selected row uses accent and descriptions use muted;
- input and ordinary answers use terminal default foreground;
- no duplicated prompt or stale completion row;
- cursor follows the final terminal cell;
- secrets never appear in capture or scrollback.

- [ ] **Step 7: Update spec/plan acceptance records**

Append a `Verification Record` section to both documents containing the exact
commands run, pass counts reported by Node, and the tmux observations. Do not
record API keys, terminal environment secrets, or provider responses.

- [ ] **Step 8: Commit Task 11**

```bash
git add scripts/tui-smoke.sh scripts/tui-ui.test.ts scripts/tui-screen.test.ts scripts/helpers/terminal-emulator.ts README.md docs/superpowers/specs/2026-08-27-tui-component-system-design.md docs/superpowers/plans/2026-08-27-tui-component-system.md
git diff --cached --check
git commit -m "test(tui): verify componentized terminal flows"
```

---

## Final Review Gate

After Task 11, dispatch a whole-branch review using
`superpowers:requesting-code-review`. The reviewer must compare the branch to
the base commit and verify these specific invariants:

1. Every current interactive command uses `CommandPresenter` and a component or
   typed notice.
2. No business component emits ANSI or literal theme colors.
3. No interactive path writes stdout outside `InteractiveTerminalLoop`.
4. `PiMainScreenRenderer` behavior and terminal emulator regressions remain
   intact.
5. Secret values cannot enter transcript or terminal output.
6. Plain mode remains append-only and factually equivalent.
7. No unrelated files are staged or committed.

Address all review findings, rerun `npm run build`, `npm test`,
`npm run smoke:tui`, and `git diff --check`, then present the final branch and
verification state to the user. Do not merge or push unless the user explicitly
requests it.

## Verification Record

Task 11 was verified from the `tui-component-system` worktree without real
provider calls, real API keys, provider responses, or paid network services.

Commands and results:

```text
npm run build
PASS

node --test scripts/tui-screen.test.ts scripts/tui-ui.test.ts
tests 117, pass 117, fail 0

npm test
tests 588, pass 587, fail 0, skipped 1

npm run smoke:tui
PASS

git diff --check
PASS
```

The render-wakeup regression was first recorded red with the focused idle-loop
test at `tests 1, pass 0, fail 1`. After `TerminalUI.appendTranscript()` was
made to request a loop render, the same test reported `tests 1, pass 1, fail 0`.
The strict smoke then proved `/help` rendered before any subsequent input.

Controlled tmux observations at 80x24, with a resize to 52x16:

- Startup, slash completion, `/help`, `/providers`, `/model`, `/effort`,
  Escape cancellation, mixed `abc` plus CJK input, resize, and login masking
  rendered through the built CLI using isolated local configuration.
- No capture contained a global frame, numbered interactive list, duplicate
  prompt, stale completion row, or literal terminal negotiation fragment.
- Help descriptions and selector descriptions used muted styling; selected
  model and effort rows used accent styling. Provider states used distinct
  semantic status colors rather than an all-grey view.
- Mixed ASCII/CJK input used the terminal default foreground. The terminal
  cursor was at column 9 for `❯ abc` plus two CJK characters before resize and
  remained at column 9 after resize.
- The authentication dialog displayed bullets only. The supplied local test
  value did not appear in capture or scrollback, and authentication was
  cancelled without changing credentials.
- A temporary offline fake-session harness ran the real `StdTerminalDriver`,
  raw loop, `PiMainScreenRenderer`, transcript reducer, and Ctrl+O display
  action inside tmux. No harness file was added to the repository because this
  was a manual terminal acceptance fixture, not product behavior.
- The collapsed capture showed frozen reasoning, an ordinary answer with no
  explicit foreground SGR, and a completed local tool without its output. The
  late reasoning delta was absent. Ctrl+O produced an expanded capture with
  the local tool output, and the second submitted turn preserved both answers
  with tmux `history_size` equal to 3.
- Terminal-emulator coverage remains the deterministic regression layer for
  reasoning freeze, answer styles, tool folding, resize persistence, and
  second-turn history; the offline tmux harness now independently verifies
  those surfaces in a real terminal without a provider-backed turn.

Fix round 1 also replaced fixed 200ms smoke delays with bounded polling. The
smoke polls startup, slash completion, completion dismissal, `/help`, and ASCII
input every 100ms for up to five seconds, validates the successful capture,
and prints the last capture on timeout. `/help` must still appear before any
subsequent key.
