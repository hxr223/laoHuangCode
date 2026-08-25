# TUI Component Architecture Design

## Status and scope

This document defines the component architecture for LaoHuangCode's terminal UI.
It covers the ownership of `src/tui/`, the component contract, composition and
input boundaries, the first extracted components, removal of duplicate editor and
decoder implementations, and the verification required to preserve terminal
behavior.

The design restructures the existing TypeScript TUI. It does not add new end-user
features, copy Pi's full component catalog, or change the Agent runtime, model
adapters, tool execution, session lifecycle, or non-TTY output contract.

## End-state product contract

`src/tui/` is a self-contained, extensible terminal UI subsystem. A new visible or
interactive terminal feature can be added as a component and mounted through the
existing composition, focus, overlay, and render paths without adding feature-
specific rendering or input logic to `TerminalUI`.

The completed architecture must satisfy all of these properties:

1. `TerminalUI` owns assembly, event routing, focus coordination, render
   scheduling, terminal lifecycle, and loop coordination.
2. Components own feature-specific presentation and optional normalized input
   handling.
3. Components do not call model clients, tools, Agent runtime, or session
   lifecycle objects.
4. Runtime events are projected into TUI-owned state before components render.
5. There is one canonical editor implementation and one canonical interactive
   terminal input pipeline.
6. Component output remains compatible with the existing `FrameBuilder` and
   differential screen renderer.
7. The component boundary can grow to support selectors, dialogs, containers,
   scrolling, alternate screens, and richer overlays without replacing the base
   component protocol.

An implementation that only moves private methods into helper functions does not
meet this contract. An implementation that introduces components but retains the
duplicate `Basic*` and CLI-local `Production*` input implementations also does not
meet it.

## Current architecture and problem

The repository has already consolidated terminal presentation under `src/tui/`:

- `src/tui/AGENTS.md` defines the TUI ownership boundary.
- the former `src/ui/` modules now live in `src/tui/`;
- the former `src/ui-state.ts` is now `src/tui/state.ts`;
- terminal byte handling, editor state, themes, screen painting, focus, overlays,
  transcript storage, and frame construction are colocated under `src/tui/`.

Three structural problems remain:

1. `TerminalUI` still renders transcript entries, tool cards, and completion rows
   through private methods. It therefore remains both the application coordinator
   and the owner of feature-specific presentation.
2. `src/tui/ui.ts` contains `BasicEditorState` and `BasicInputDecoder`, while the
   richer canonical implementations already exist in `src/tui/editor.ts`.
3. `src/cli.ts` contains `ProductionEditor` and `ProductionInputDecoder` adapters
   and injects them into `TerminalUI`. This makes the CLI aware of internal TUI
   implementation choices and leaves two behavioral paths available.

The result is a directory boundary without a complete component boundary.

## Pi comparison and deliberate differences

Pi's `packages/tui` provides a general terminal UI framework. Its core `Component`
contract includes `render(width)`, optional raw input handling, and render cache
invalidation. Stateful component instances are mounted into containers, focused
by the TUI, composed into overlays, measured by a layout engine, and ultimately
painted by main-screen or alternate-screen renderers.

Pi also provides a broad component and layout catalog, including text, Markdown,
input, editor, selection lists, boxes, containers, horizontal and vertical stacks,
scroll views, and images. Its coding-agent package selects and assembles those
general components into the product UI.

LaoHuangCode will adopt the same stable extension seam, not the complete Pi
implementation:

| Concern | Pi | LaoHuangCode design |
| --- | --- | --- |
| Render contract | component returns width-bounded terminal lines | same invariant |
| Input | component may receive raw terminal strings | component receives normalized `TuiInputEvent` |
| Invalidation | component clears cached render state | same lifecycle hook |
| Focus | focusable component participates in cursor/input routing | optional typed focusable contract integrated with `FocusManager` |
| Composition | generic component tree and layout nodes | existing `FrameBuilder` remains the root compositor |
| Overlay | components are positioned and composited as overlays | existing `OverlayManager` remains policy owner and accepts components |
| Renderer | main/alternate screen implementations | existing differential screen renderer remains authoritative |

The normalized input difference is intentional. LaoHuangCode already separates
terminal byte buffering, terminal negotiation, key decoding, keybindings, and UI
events. Passing raw escape sequences back into components would collapse those
boundaries and make component tests terminal-dependent.

The retained `FrameBuilder` difference is also intentional. The current product
has a known Coding Agent layout and differential rendering behavior. A generic
layout engine is not required to establish an extensible component contract, and
replacing `FrameBuilder` would combine two independent architectural changes.

## Component protocol

Add a dedicated component contract under `src/tui/component.ts`:

```ts
export interface TuiComponent {
  render(width: number): readonly string[];
  handleInput?(event: TuiInputEvent): boolean;
  invalidate(): void;
}

export interface FocusableComponent extends TuiComponent {
  focused: boolean;
}
```

The methods have these contracts:

- `render(width)` returns complete terminal lines whose visible width never
  exceeds `width`. ANSI style sequences do not count toward visible width.
- `handleInput(event)` is present only on interactive components. It returns
  `true` when the event was consumed and `false` when the host may continue
  routing it.
- `invalidate()` clears component-owned render caches or derived display state.
  Stateless components implement it as a no-op.
- `focused` is host-managed. A focusable component may use it to render cursor or
  selection state but must not select itself as the active focus target.

The protocol does not include runtime services, a global UI singleton, or direct
terminal writes. Components are rendered and hosted by the TUI; they do not own
the terminal lifecycle.

## Component ownership

The initial component directory is:

```text
src/tui/
├── component.ts
└── components/
    ├── completion-list.ts
    ├── tool-card.ts
    └── transcript.ts
```

The existing `src/tui/components.ts` continues to own stable component and overlay
identifiers. It is not the component protocol and should not accumulate component
implementations.

### CompletionList

`CompletionList` receives completion items, the selected index, and the maximum
visible row count. It owns:

- selection markers;
- item description formatting;
- maximum-row enforcement;
- trailing-whitespace cleanup;
- visible-width truncation.

It does not modify editor state. Accepting or moving the selection remains an
editor/input action.

### ToolCard

`ToolCard` receives one tool transcript block and the active terminal theme. It
owns:

- pending, success, and error presentation;
- subject/title formatting;
- output and error clipping;
- background and accent styling;
- card padding and width enforcement.

It does not interpret tool schemas or execute tools. The transcript projection
must already have converted tool lifecycle events into a display block.

The component boundary permits future specialized cards such as read, bash, diff,
and edit cards. Those components must implement the same protocol and be selected
by transcript presentation policy rather than by `TerminalUI`.

### Transcript

`Transcript` receives ordered `TranscriptBlock` values and the current theme. It
owns:

- ordering and spacing of transcript blocks;
- Markdown rendering for assistant blocks;
- user, thinking, notice, and error presentation;
- delegation of tool blocks to `ToolCard`;
- calculation of the first mutable row used as `activeStart` by differential
  rendering.

Because `activeStart` is layout metadata in addition to rendered lines,
`Transcript` exposes a typed detailed render result while its `TuiComponent.render`
method returns the lines alone:

```ts
interface TranscriptRenderResult {
  readonly lines: readonly string[];
  readonly activeStart: number | null;
}
```

`TerminalUI.buildHistoryLines()` remains as a compatibility-facing delegation
point but no longer contains transcript presentation rules.

## Composition and data flow

The display path is:

```text
Core runtime events
        |
        v
Display actions / UI state projection
        |
        v
TranscriptStore
        |
        v
Transcript ---- tool block ----> ToolCard
        |
        +-------------------------------+
                                        v
EditorState ---- completions ----> CompletionList
                                        |
                                        v
                                  FrameBuilder
                                        |
                                        v
                                   TerminalUI
                                        |
                                        v
                            differential screen renderer
```

`TerminalUI` obtains transcript lines and `activeStart` from `Transcript`, obtains
completion rows from `CompletionList`, and passes both plus the editor into
`FrameBuilder`. It schedules and paints the resulting screen frame but does not
format any transcript or completion content itself.

## Input and editor convergence

The end state has one editor and one decoder pipeline:

```text
stdin bytes
    |
    v
StdinBuffer
    |
    v
TerminalInputFilter
    |
    v
RawInputDecoder
    |
    v
TuiInputEvent / InputAction
    |
    v
EditorState or focused component
```

The following duplicate implementations are removed:

- `BasicEditorState` from `src/tui/ui.ts`;
- `BasicInputDecoder` from `src/tui/ui.ts`;
- `ProductionEditor` from `src/cli.ts`;
- `ProductionInputDecoder` from `src/cli.ts`.

`EditorState` becomes the default editor used by `TerminalUI`. Its render result
shape and the `EditorLike` contract are normalized so that no wrapper exists only
to rename `cursorColumn` to `cursorCol`.

A TUI-owned `TerminalInputDecoder` composes `StdinBuffer`,
`TerminalInputFilter`, and `RawInputDecoder`. `TerminalUI` creates it by default.
The CLI supplies process streams and lifecycle hooks but does not select internal
editor or decoder classes.

Factory injection remains available for deterministic tests and intentionally
custom editor integrations. It is not used to maintain an alternative built-in
implementation.

## Focus, overlays, and future containers

The first extracted components are display components, but the protocol establishes
the interaction contract required for later components:

- `FocusManager` stores and changes the active component identity;
- `TerminalUI` routes normalized input to the focused component first;
- an overlay mounts a `TuiComponent`, with `OverlayManager` retaining priority,
  visibility, and restoration policy;
- a future container owns child ordering and delegates invalidation;
- future stack and scroll components can add layout metadata without changing the
  base render/input/invalidation contract.

The intended extension tree is:

```text
TuiComponent
├── display
│   ├── Transcript
│   ├── ToolCard
│   ├── CompletionList
│   ├── Markdown
│   └── StatusBar
├── interactive
│   ├── Editor
│   ├── Selector
│   └── Dialog
└── container
    ├── Container
    ├── VStack / HStack
    ├── ScrollView
    └── Overlay content
```

This is an extension contract, not a requirement to create unused components.
New components are added when the corresponding product behavior exists, while
remaining compatible with the protocol established here.

## Render scheduling and invalidation

State changes remain host-driven:

1. runtime or input processing mutates TUI-owned state;
2. the owner invalidates the affected component when it has cached derived output;
3. `TerminalUI` coalesces render requests through the existing scheduling path;
4. components render a logical frame;
5. the screen renderer determines the changed terminal rows.

Components do not write to stdout and do not independently start timers that
paint the terminal. A future animated component receives a host callback or clock
dependency through its constructor; it still requests rendering through the host.

## Error handling and invariants

The component layer preserves these invariants:

- every rendered line fits the supplied visible width;
- widths below a component's preferred size degrade through wrapping or
  truncation rather than negative padding;
- missing optional descriptions, tool details, or theme tokens have deterministic
  fallback presentation;
- malformed runtime data is handled by the display projection and does not cause
  a component to call runtime services for recovery;
- component exceptions are not silently swallowed by `TerminalUI`;
- input not consumed by a focused component continues through the existing global
  keybinding and lifecycle path;
- non-TTY `PlainEventSink` remains independent from the component tree.

## Implementation order

The implementation order does not reduce the end-state contract:

1. Retain and enforce `src/tui/AGENTS.md` as the directory ownership rule.
2. Complete the relocation of former `src/ui/` and `src/ui-state.ts` code under
   `src/tui/` and keep external imports updated.
3. Add the `TuiComponent` and `FocusableComponent` contracts.
4. Extract `CompletionList`, `ToolCard`, and `Transcript`; make `TerminalUI`
   delegate to them.
5. Normalize the editor render contract and make `EditorState` the sole built-in
   editor.
6. Add the TUI-owned `TerminalInputDecoder`; remove the `Basic*` and CLI-local
   `Production*` implementations.
7. Run focused tests, the TypeScript build, the complete test suite, and the
   controlled TUI smoke test.

## Verification

Focused component tests must cover:

- completion selection, row limits, descriptions, and narrow-width truncation;
- tool pending/success/error variants, clipping, ANSI-visible width, and narrow
  terminals;
- transcript ordering, Markdown, tool delegation, mutable block detection, and
  `activeStart`;
- component invalidation behavior;
- normalized input consumption and fallthrough for an interactive fake component.

Integration tests must cover:

- `TerminalUI` delegates history and completion rendering to components;
- `FrameBuilder` receives the same logical content and cursor position as before;
- the canonical editor preserves submission, history, completion, multiline,
  Unicode-width, cancellation, and EOF behavior;
- the canonical decoder preserves split escape sequences, bracketed paste, Kitty
  keyboard events, modifyOtherKeys negotiation, and Apple Terminal Shift+Enter;
- CLI interactive mode starts without supplying private editor/decoder adapters;
- non-TTY output remains unchanged.

Required final commands are:

```bash
npm run build
npm test
npm run smoke:tui
```

The smoke test must use a controlled terminal and must not call a real provider or
require API credentials.

## Acceptance criteria

The refactor is complete only when:

1. `src/tui/AGENTS.md` contains the TUI ownership and component rules.
2. no active source remains under `src/ui/`, `src/terminal/`, or
   `src/ui-state.ts`.
3. a typed component protocol supports rendering, normalized input, invalidation,
   and focus participation.
4. `ToolCard`, `CompletionList`, and `Transcript` are independent components with
   focused tests.
5. `TerminalUI` contains no feature-specific rendering implementation for those
   three components.
6. `BasicEditorState`, `BasicInputDecoder`, `ProductionEditor`, and
   `ProductionInputDecoder` no longer exist.
7. `EditorState` and the TUI-owned terminal decoder are the default interactive
   implementations.
8. `src/cli.ts` does not construct or adapt TUI-internal editor/decoder classes.
9. build, complete tests, and the controlled TUI smoke test pass.
10. the existing runtime, session, tool, non-TTY, and differential-rendering
    behavior remains intact.
