# TUI Component Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the component architecture from `docs/superpowers/specs/2026-08-25-tui-component-architecture-design.md` so visible TUI pieces are reusable components and the interactive loop uses one canonical editor/input pipeline.

**Architecture:** `src/tui/component.ts` defines the component contract. `src/tui/components/` owns `CompletionList`, `ToolCard`, and `Transcript`; `TerminalUI` delegates rendering of completion rows and transcript blocks to those components while keeping terminal lifecycle and scheduling. The default interactive editor/decoder becomes `EditorState` plus a TUI-owned `TerminalInputDecoder`; the older `Basic*` and CLI-local production adapters are removed.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing `src/tui/editor.ts`, `src/tui/screen.ts`, `src/tui/theme.ts`, and `src/tui/transcript-store.ts`.

**Spec:** `docs/superpowers/specs/2026-08-25-tui-component-architecture-design.md`

## Global Constraints

- Source lives in `src/`; tests and repository engineering automation live in `scripts/`.
- Use strict TypeScript. Avoid `any` unless there is no reasonable typed alternative.
- Use top-level imports. Do not use inline dynamic imports or dynamic type imports unless the runtime behavior specifically requires them.
- Keep TypeScript syntax erasable in files run directly by Node tests: no `enum`, `namespace`/`module`, parameter properties, `import =`, or `export =`.
- Do not edit generated or packaged artifacts such as `dist/`, `build/`, egg-info, or vendored release files.
- After code changes, run `npm run build` and `npm test`.
- Do not commit unless the user asks.

---

### Task 1: Component Contract And Focused Component Tests

**Files:**
- Create: `src/tui/component.ts`
- Create: `src/tui/components/completion-list.ts`
- Create: `src/tui/components/tool-card.ts`
- Create: `src/tui/components/transcript.ts`
- Modify: `scripts/tui-ui.test.ts`

**Interfaces:**
- Produces: `TuiComponent`, `FocusableComponent`, `CompletionList`, `ToolCard`, `Transcript`, and `TranscriptRenderResult`.
- Consumes: `TuiInputEvent`, `CompletionItemLike`, `TerminalTheme`, `TranscriptBlock`.

- [ ] **Step 1: Write failing tests for the component contract behavior**

Add tests to `scripts/tui-ui.test.ts` asserting:

```ts
const list = new CompletionList({
  items: [
    { value: "/help", description: "Show help", start: -5 },
    { value: "/model", description: "Switch model", start: -6 },
  ],
  selectedIndex: 1,
});
assert.deepEqual(list.render(20), ["  /help  Show help", "› /model  Switch"]);
assert.equal(list.focused, false);
list.focused = true;
assert.equal(list.focused, true);
```

Add a `ToolCard` test asserting a completed tool renders title, status, exit code, duration, and expanded output inside the width. Add a `Transcript` test asserting mutable blocks report `activeStart` at the first mutable rendered row.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test scripts/tui-ui.test.ts`

Expected: fail because `src/tui/components/completion-list.ts`, `tool-card.ts`, and `transcript.ts` do not exist.

- [ ] **Step 3: Add the component protocol and three components**

Implement:

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

`CompletionList.render(width)` returns up to six rows with the selected row marker. `ToolCard.render(width)` returns width-bounded rows for one tool transcript block. `Transcript.render(width)` returns all transcript lines and `renderWithMetadata(width)` returns `{ lines, activeStart }`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test scripts/tui-ui.test.ts`

Expected: pass for the new component tests and preserve existing TUI UI assertions.

### Task 2: TerminalUI Uses The Components

**Files:**
- Modify: `src/tui/ui.ts`
- Modify: `scripts/tui-ui.test.ts`

**Interfaces:**
- Consumes: `Transcript.renderWithMetadata(width)` and `CompletionList.render(width)`.
- Produces: `TerminalUI.buildHistoryLines(width)` and `TerminalUI.buildFrame(...)` behavior unchanged from the caller perspective.

- [ ] **Step 1: Write failing delegation tests**

Add tests that mutate a transcript with assistant/tool/user blocks and assert `TerminalUI.buildHistoryLines()` matches `new Transcript(...).renderWithMetadata(width).lines`. Add a frame test that slash-command completions still appear after `TerminalUI.buildFrame(...)`.

- [ ] **Step 2: Run the focused test and verify it fails before delegation**

Run: `node --test scripts/tui-ui.test.ts`

Expected: fail until `TerminalUI` renders transcript/completions through component classes.

- [ ] **Step 3: Replace private transcript/completion rendering with component delegation**

Update `TerminalUI` so `#buildHistoryFrameParts` creates `new Transcript({ blocks, theme })` and `#completionLines` creates `new CompletionList({ items, selectedIndex })`. Keep ANSI styling and visible-width truncation inside component files.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test scripts/tui-ui.test.ts`

Expected: pass.

### Task 3: Default Editor And Decoder Convergence

**Files:**
- Create: `src/tui/terminal-input-decoder.ts`
- Modify: `src/tui/ui.ts`
- Modify: `src/tui/frame-builder.ts`
- Modify: `src/cli.ts`
- Modify: `scripts/tui-ui.test.ts`
- Modify: `scripts/cli.test.ts`

**Interfaces:**
- Produces: `TerminalInputDecoder implements InputDecoderLike`.
- Consumes: `EditorState`, `StdinBuffer`, `TerminalInputFilter`, `RawInputDecoder`, and `toTuiInputEvent`.

- [ ] **Step 1: Write failing tests for default input convergence**

Add tests asserting a default `TerminalUI({ driver })` uses the canonical editor semantics: two idle Ctrl+C inputs request exit through `EditorState.DOUBLE_CANCEL_EXIT_MS`, and bracketed paste inserts one paste payload through the default decoder.

Add a CLI test asserting persistent terminal setup no longer needs `ProductionEditor` or `ProductionInputDecoder` classes exported from `src/cli.ts`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test scripts/tui-ui.test.ts scripts/cli.test.ts`

Expected: fail because defaults still use `BasicEditorState` and `BasicInputDecoder`.

- [ ] **Step 3: Implement `TerminalInputDecoder`**

Implement a wrapper that feeds bytes through `StdinBuffer`, filters `BufferedInputKind.Sequence` through `TerminalInputFilter`, decodes through `RawInputDecoder`, turns paste into an insert action, exposes `kittyProtocolActive`, and clears all three pipeline pieces.

- [ ] **Step 4: Normalize editor render shape and defaults**

Change `EditorRenderResult.cursorCol` to `cursorColumn`, update `FrameBuilder`, remove `BasicEditorState`, `BasicInputDecoder`, and related helper code from `src/tui/ui.ts`, and default `TerminalUI` to `new EditorState()` plus `new TerminalInputDecoder(hooks)`.

- [ ] **Step 5: Remove CLI-local production wrappers**

Delete `ProductionEditor` and `ProductionInputDecoder` from `src/cli.ts`; wire persistent TUI creation directly through default `TerminalUI` options unless a test passes an explicit factory.

- [ ] **Step 6: Run focused tests and verify they pass**

Run: `node --test scripts/tui-ui.test.ts scripts/cli.test.ts`

Expected: pass.

### Task 4: Full Verification And Cleanup

**Files:**
- Modify only files touched by Tasks 1-3 if failures expose needed fixes.

**Interfaces:**
- Consumes: repo npm scripts.
- Produces: verified codebase state with no remaining `BasicEditorState`, `BasicInputDecoder`, `ProductionEditor`, or `ProductionInputDecoder` references.

- [ ] **Step 1: Search for removed duplicate classes**

Run: `rg -n "BasicEditorState|BasicInputDecoder|ProductionEditor|ProductionInputDecoder" src scripts`

Expected: no output.

- [ ] **Step 2: Run build**

Run: `npm run build`

Expected: exit 0.

- [ ] **Step 3: Run full tests**

Run: `npm test`

Expected: exit 0.

- [ ] **Step 4: Run TUI smoke**

Run: `npm run smoke:tui`

Expected: exit 0 and no provider/API-key calls.

- [ ] **Step 5: Inspect final diff**

Run: `git status --short` and `git diff --check`

Expected: only intended changed/untracked files are present; whitespace check is clean.
