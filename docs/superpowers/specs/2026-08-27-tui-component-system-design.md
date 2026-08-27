# LaoHuang TUI Component System Design

## Goal

Replace interactive-session string formatting with a coherent, typed TUI
component system for every feature currently exposed by LaoHuang. The terminal
must keep the existing raw input loop and Pi-compatible regular-screen renderer,
while command views, transcript messages, selectors, dialogs, completion, and
status output become reusable components with centralized styling.

This is a complete contract for the current LaoHuang feature set. A command is
not componentized if its interactive path still constructs numbered text lists,
publishes preformatted ANSI, or routes a structured view through a generic grey
`ui.message` block.

## Product Contract

In an interactive TTY session:

- `/model` opens a searchable model selector with keyboard navigation,
  confirmation, cancellation, current-model indication, provider metadata, and
  width-safe scrolling.
- `/effort` opens a reasoning-effort selector showing the current value and only
  values supported by the active model.
- `/login`, `/logout`, and `/apikey` use provider selection, masked credential
  input, text input, or option selection inside the persistent terminal loop.
- `/providers` renders a provider status list or provider detail view with
  separate `available`, `configured`, and `verified` states.
- `/help` renders command names, usage, and descriptions as structured spans.
- `/queue` renders pending, held, token-estimate, and dead-letter fields as a
  structured status view.
- `/cancel`, `/clear`, model switching, effort changes, credential changes,
  unknown commands, rejected input, shutdown, and runtime errors use typed
  notice components.
- User input, assistant Markdown, reasoning, tool execution, bash execution,
  welcome text, completion candidates, and the footer each have dedicated
  components.
- Ordinary input, assistant text, unselected command names, and unselected model
  names use the terminal default foreground. Descriptions and secondary metadata
  use `muted`; prompts and selected rows use `accent`.
- The terminal uses native scrollback for frozen transcript content and redraws
  only the active region. Components may not bypass `InteractiveTerminalLoop` or
  `PiMainScreenRenderer` to write interactive stdout.
- The root layout is unframed. The current full-screen `╭─╮` frame is removed;
  borders and backgrounds are used only for genuinely bounded surfaces such as
  tool cards and authentication dialogs.

In a non-interactive session:

- `--help`, `--version`, piped sessions, setup prompts, and `PlainEventSink`
  remain append-only plain text.
- Plain output contains no cursor-control sequences and does not instantiate
  interactive components.
- The same command-domain presentation models are formatted by a plain presenter
  so interactive and non-interactive behavior report the same facts.

## Non-Goals

- Do not migrate to Ink, React, Ratatui, prompt_toolkit, or another TUI runtime.
- Do not replace `PiMainScreenRenderer`, `StdinBuffer`, `TerminalInputFilter`,
  `RawInputDecoder`, `EditorState`, AgentSession, the event bus, model adapters,
  provider catalog, credential storage, or tool runtime.
- Do not add alternate-screen mode, mouse support, terminal images, extension
  UI, or components for commands that do not exist in LaoHuang.
- Do not execute Pi or Codex code at runtime. Reference implementations define
  behavior and composition; LaoHuang owns its TypeScript implementation.

## Reference Strategy

Use Pi for interaction behavior and visual composition, Codex for structured
text and typed history-cell ideas, and LaoHuang for terminal ownership and
business data.

| LaoHuang component | Reference | Binding behavior |
| --- | --- | --- |
| `StyledSpan`, `StyledLine` | Codex Ratatui `Span` and `Line` usage | A line is structured spans until the final ANSI compilation boundary. |
| `Text` | Pi `packages/tui/src/components/text.ts` | Width-aware wrapping, horizontal/vertical padding, optional background fill, render caching. |
| `VStack` | Pi `packages/tui/src/components/v-stack.ts` | Ordered child composition with explicit gaps and no hidden viewport allocation. |
| `Box` | Pi `packages/tui/src/components/box.ts` | Padding and background fill around child components; no default decorative border. |
| `SelectList` | Pi `packages/tui/src/components/select-list.ts` | Up/down wrapping, Enter selection, Escape/Ctrl+C cancellation, centered scrolling, optional descriptions and scroll position. |
| `SearchInput`, `Composer` | Pi `Input`/`Editor`; existing LaoHuang editor | Pi presentation; LaoHuang input buffering, CJK cursor cells, paste, history, and completion remain authoritative. |
| `ViewHost` | Pi overlay composition; LaoHuang `OverlayManager`/`FocusManager` | One focused selector/modal at a time, priority ordering, Promise-based completion, return focus to composer. |
| `CompletionPopup` | Pi editor autocomplete | Prompt accent, default candidate name, muted description, selected row accent, actual candidate height. |
| `ModelSelector` | Pi `model-selector.ts` | Search input, filtered list, selected details, current model marker, background refresh result, cancellation. |
| `EffortSelector` | Pi `thinking-selector.ts` | `SelectList` composition with current value selected. |
| `ProviderSelector` | Pi `SelectList` | Provider selection using LaoHuang catalog data. |
| `AuthDialog` | Pi `login-dialog.ts` | Text/secret/select prompts inside one focused dialog, masking, cancellation, status feedback. |
| `HelpView` | Pi list styling; Codex structured lines | Command usage in default foreground and description in muted foreground. |
| `ProviderStatusView` | Codex history-cell composition | Typed key/value rows and semantic state colors; LaoHuang provider state semantics. |
| `QueueStatusView` | Codex status/history cells | Typed queue fields and compact responsive layout. |
| `UserMessage` | Pi `user-message.ts` | Full-width user background with padding. |
| `AssistantMessage`, `ThinkingMessage` | Pi `assistant-message.ts` | Markdown answer, muted italic reasoning, independent visibility/freeze lifecycle. |
| `ToolMessage`, `BashMessage` | Pi `tool-execution.ts`, `bash-execution.ts` | Semantic status background/title/output, expansion, exit code and duration. |
| `NoticeMessage`, `ErrorMessage` | Codex `history_cell/notices.rs` | Typed tone, prefix, wrapped body; no arbitrary style strings from callers. |
| `StatusLine` | Pi `footer.ts` | Responsive left/right fields for cwd, queue, token counts, provider/model, and effort. |
| Root layout | Pi main-screen composition | Transcript plus active dock; no global frame; renderer remains regular-screen append/diff engine. |

## Architecture

### Rendering layers

```text
Agent/runtime events                 Slash-command domain logic
        |                                      |
        v                                      v
typed TranscriptBlock                 CommandPresentation models
        |                                      |
        v                                      v
message components                   interactive/plain presenter
        |                                      |
        +------------------+-------------------+
                           v
                  TuiComponent tree
                           |
                           v
                 StyledLine / StyledSpan
                           |
                           v
                 compileStyledLines(theme)
                           |
                           v
                      ScreenFrame
                           |
                           v
                 PiMainScreenRenderer
```

`PiMainScreenRenderer` continues to receive ANSI strings because terminal
diffing and cursor placement are terminal-engine responsibilities. ANSI is
introduced exactly once, immediately before `ScreenFrame` construction.

### Structured render model

Create `packages/terminal/tui/src/tui/render-model.ts` with these public types:

```ts
export type StyleToken =
  | "accent"
  | "text"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "user_bg"
  | "tool_pending_bg"
  | "tool_success_bg"
  | "tool_error_bg"
  | "card"
  | "code"
  | "heading"
  | "link"
  | "thinking"
  | "bash";

export interface SpanStyle {
  readonly foreground?: StyleToken;
  readonly background?: StyleToken;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly dim?: boolean;
}

export interface StyledSpan {
  readonly text: string;
  readonly style?: SpanStyle;
}

export interface StyledLine {
  readonly spans: readonly StyledSpan[];
}

export interface RenderContext {
  readonly width: number;
  readonly theme: TerminalTheme;
}

export interface ComponentRenderResult {
  readonly lines: readonly StyledLine[];
  readonly cursor?: { readonly row: number; readonly column: number };
}
```

Update `TuiComponent` to return `ComponentRenderResult`:

```ts
export interface TuiComponent {
  render(context: RenderContext): ComponentRenderResult;
  handleInput?(event: TuiInputEvent): boolean;
  invalidate(): void;
}
```

An omitted foreground means terminal default foreground. `StyleToken.text` is
used only when text must be restored over an explicit background. Components
must never embed SGR sequences in `StyledSpan.text`.

### Component ownership

Components fall into three categories:

1. Primitives (`Text`, `VStack`, `Box`, `SelectList`) own layout and generic
   interaction but no LaoHuang business data.
2. Transcript components own one immutable or mutable display block and render
   it through primitives.
3. Command components own temporary selection/dialog state or render frozen
   command results from typed presentation models.

Stateful selectors and dialogs are long-lived for the duration of an active
view. Transcript components may be recreated each render from typed blocks.

### Active view lifecycle

`OverlayManager` stores actual components:

```ts
export interface OverlayEntry {
  readonly id: string;
  readonly priority: "completion" | "selector" | "modal";
  readonly component: FocusableComponent;
  readonly placement: "dock";
}
```

`TerminalUI` exposes generic Promise-based interactions:

```ts
select(request: SelectionRequest): Promise<string | null>;
prompt(request: PromptRequest): Promise<string | null>;
```

Opening a view queues a loop work item. Input is routed to the top focused view
before global keybindings and the composer. Resolve with a value on submit and
`null` on Escape/Ctrl+C. Closing restores composer focus and requests exactly
one render.

### Command presentation boundary

Create `apps/cli/src/command-presentation.ts`. `SessionCommands` depends on a
UI-neutral presenter rather than `InputFn` plus `OutputFn`:

```ts
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

`TerminalCommandPresenter` maps these models to TUI components and loop views.
`PlainCommandPresenter` formats the same models as append-only text. Runtime
`CommandResult` remains unchanged and must not import TUI types.

Static command results become typed transcript blocks so they remain in native
scrollback. Active selectors and dialogs are overlays and are never committed
to transcript history as numbered prompt text.

### Model selection

`ModelSelector` becomes a UI-neutral domain service:

```ts
listProviders(): readonly ModelProviderInfo[];
listModels(provider: string, query: string): Promise<readonly ModelInfo[]>;
selectExact(options: {
  providerName: string;
  modelName: string;
  promptForMissingKey: boolean;
  authPrompts?: AuthPromptHandler;
}): Promise<ModelSelection | null>;
```

The interactive presenter gathers provider/model values through components,
then asks the service to validate and construct the selection. Startup setup
uses a separate plain prompt flow built on the same service; setup prompts do
not run inside the persistent loop.

### Authentication

`ProviderAuthController` keeps credential operations but receives prompt
interactions per login instead of storing terminal input/output callbacks:

```ts
login(provider: string, prompts: AuthPromptHandler): Promise<ModelAuthStatus | null>;
logout(provider: string): Promise<ModelAuthStatus>;
status(provider: string): Promise<ModelAuthStatus>;
ensureConfigured(provider: string, options: {
  promptIfMissing: boolean;
  prompts?: AuthPromptHandler;
}): Promise<boolean>;
```

`AuthPromptHandler` maps `secret`, `text`, and `select` setup requests to either
`AuthDialog` or plain input. Secret values never enter transcript blocks,
presentation models, logs, test snapshots, or error messages.

Session `/model` calls `selectExact` with `promptForMissingKey: false` and no
prompt handler. Startup selection passes the plain prompt handler; requesting a
missing-key prompt without a handler is a configuration error rather than an
implicit read from stdin.

## Transcript Model

Replace the current open-ended `kind: string` block with a discriminated union.
Required variants are:

- `user`
- `assistant`
- `thinking`
- `tool`
- `notice`
- `help`
- `provider_list`
- `provider_detail`
- `queue_status`
- `welcome`

Each variant owns only the fields its component needs. Correlation lookup is
limited to mutable assistant, thinking, and tool blocks. Static command blocks
use generated local ids and freeze immediately.

## Root Layout

The regular-screen logical tree is:

```text
MainScreen
├── Transcript
└── Dock
    ├── Active selector/modal, when present
    ├── Composer, otherwise
    ├── CompletionPopup, when composer completion is open
    └── StatusLine
```

Frozen transcript lines precede the mutable active region. `FrameBuilder`
computes cursor coordinates from the selected dock component's reported cursor
and concatenates lines without a global frame. Full-width backgrounds are
padded to `width - 1` when required by terminal autowrap safety.

## Visual Contract

| Content | Foreground/background |
| --- | --- |
| Prompt | `accent` |
| Typed input | terminal default foreground |
| Assistant Markdown body | terminal default, Markdown semantic overrides only |
| Unselected command/model/provider name | terminal default foreground |
| Description and metadata | `muted` |
| Selected prefix and selected row text | `accent`; no selected-row background |
| Thinking | `thinking`, italic |
| Bash command title | `bash`, bold |
| Tool running/completed/failed | pending/success/error background with semantic title color |
| User message | `user_bg`; foreground restored with `text` |
| Success/warning/error | `success` / `warning` / `error` |
| Footer | `dim` metadata; provider/model in terminal default foreground |

Dark and light themes must preserve semantic contrast. Components select tokens,
never literal hex colors.

## Error and Cancellation Behavior

- Component render failures set the loop render error and request controlled
  shutdown through the existing path.
- Selector cancellation resolves `null` and appends no numbered-list history.
- Invalid direct command arguments append an error or warning component with
  exact usage text.
- Authentication cancellation returns `null` without reporting success.
- Authentication service errors use `ErrorMessage` and never expose supplied
  credentials.
- A blocked command uses `WarningMessage` and remains a handled command result.
- Unknown commands keep suggestion behavior and render through `NoticeMessage`.

## Test Contract

The implementation is accepted only when all of the following are covered:

- Structured-line tests prove ANSI is introduced only by the compiler and that
  default foreground spans remain uncolored.
- Primitive tests cover ANSI-safe width, CJK width, wrapping, padding, select
  navigation, cancellation, scrolling, empty results, and narrow terminals.
- Component snapshots cover widths 40 and 80 in dark and light themes.
- Transcript tests cover freeze boundaries and every discriminated block type.
- Command tests assert presentation models rather than grey output strings.
- Integration tests execute `/help`, `/model`, `/effort`, `/login`, `/logout`,
  `/apikey`, `/providers`, `/queue`, `/cancel`, and `/clear` through the
  persistent loop.
- Terminal-emulator tests prove selectors open and close without duplicate
  prompts, stale rows, scrollback clearing, or cursor displacement.
- Secret-input tests prove secrets are masked and absent from writes/history.
- `npm run build` and `npm test` pass.
- A controlled tmux smoke test covers `/`, `/help`, `/model`, `/effort`,
  `/providers`, typing three ASCII characters, typing CJK, Escape, terminal
  resize, reasoning output, and a fake/local tool display without provider calls.

## Files and Responsibilities

New TUI files:

- `tui/render-model.ts`: structured lines, spans, style tokens, helpers.
- `tui/ansi-renderer.ts`: theme compilation, width-safe line conversion.
- `tui/components/primitives/{text,v-stack,box,select-list}.ts`: reusable layout.
- `tui/components/composer.ts`: structured wrapper around existing editor state.
- `tui/components/status-line.ts`: responsive cwd/queue/token/model footer.
- `tui/components/messages/*.ts`: transcript message components.
- `tui/components/views/*.ts`: command result and selector/dialog components.
- `tui/main-screen.ts`: root component composition and cursor metadata.

Modified TUI files:

- `component.ts`: structured render contract.
- `theme.ts`: typed semantic tokens.
- `markdown.ts`: structured Markdown spans plus ANSI compilation wrapper for
  plain output.
- `editor.ts`, `contracts.ts`: structured editor line/cursor projection without
  changing input state transitions.
- `transcript-store.ts`: discriminated transcript model.
- `components/transcript.ts`: block-to-component dispatch.
- `overlay-manager.ts`, `focus-manager.ts`: real component ownership/focus.
- `ui.ts`: view work items, Promise lifecycle, input routing, presenters' public
  hooks, and single-writer integration.
- `frame-builder.ts`: remove global frame and concatenate component output.
- `components.ts`, `index.ts`: public exports.

New CLI files:

- `command-presentation.ts`: UI-neutral presentation models and presenter port.
- `terminal-command-presenter.ts`: TUI adapter.
- `plain-command-presenter.ts`: plain output adapter.

Modified CLI files:

- `commands.ts`: domain actions and presentation calls, no interactive string
  list construction.
- `model-selection.ts`: UI-neutral model selection service plus startup prompt
  flow.
- `provider-auth.ts`: prompt-handler injection and typed result handling.
- `main.ts`: interactive/plain presenter wiring.
- `repl.ts`: typed notices for command result/error paths.

Tests remain under `scripts/` and continue to run directly under Node with
erasable TypeScript syntax.

## Acceptance Criteria

1. Every current interactive LaoHuang feature listed in the product contract is
   rendered by a dedicated component or an explicitly shared notice component.
2. No interactive command handler prints numbered options or preformatted ANSI.
3. No business component emits ANSI directly.
4. `PiMainScreenRenderer` and raw terminal input behavior remain intact.
5. The full-screen decorative frame is removed without regressing native
   scrollback, cursor placement, completion shrink, resize, or frozen-history
   behavior.
6. Interactive and plain presenters report equivalent domain facts.
7. Secret credentials never reach transcript state or terminal history.
8. Build, full test suite, terminal-emulator regressions, and tmux smoke checks
   pass without real provider credentials.

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
- Reasoning-to-answer freeze, ordinary answer foreground, tool
  expand/collapse, second-turn native scrollback, and local fake tool output
  were verified in terminal-emulator coverage. The built CLI has no offline
  fake-turn entry point, so those surfaces were not driven through real tmux;
  doing so would require a prohibited provider-backed turn.
