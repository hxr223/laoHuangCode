# Pi regular-mode terminal design

## Goal

Replace laoHuangCode's persistent `prompt_toolkit` transcript window with a
Python implementation of Pi's **regular terminal mode**. Completed
conversation content must be append-only terminal history; only currently
mutable UI content may be redrawn.

This addresses two user-visible failures in the current hybrid UI:

- a completed user message disappears once later output exceeds the artificial
  transcript viewport;
- a later assistant response visually replaces an earlier response because the
  same `prompt_toolkit` screen region is repainted from a tail-truncated
  snapshot.

## Scope

Included:

- persistent interactive session rendering, raw key input, multiline editor,
  history navigation, slash-command completion, and terminal resize handling;
- ANSI differential rendering in the terminal's normal screen and scrollback;
- one UI event loop as the sole terminal writer;
- Markdown, theme, tool-card, reasoning, queue, and cancellation presentation
  in the new line model;
- deterministic tests for history persistence and active-region updates.

Not included:

- Agent, model-stream, tool, router, event-envelope, or Web dashboard changes;
- alternate-screen mode, mouse support, terminal image protocols, or Pi's file
  attachment completion;
- changing one-shot setup prompts. They may continue to use `PiInputSession`
  and `prompt_toolkit` because they do not coexist with a live transcript.

## Reference behavior

Pi's `TuiMainScreen` (`packages/tui/src/tui-main-screen.ts`) retains
`previousLines`, terminal dimensions, and cursor positions. It renders a new
full logical line sequence, finds the changed range, and emits terminal ANSI
commands only for that range. When new lines are appended, the terminal receives
newlines and stores completed content in its native scrollback.

The Python implementation follows this behavioral model; it does not embed or
depend on Pi's TypeScript runtime.

## Architecture

```text
raw stdin ──> key decoder ─┐
                            ├─> InteractiveTerminalLoop ─> PiMainScreenRenderer ─> stdout
EventBus projection ────────┘             │
                                          ├─> TranscriptBlock store
                                          └─> EditorState / CompletionState
```

`InteractiveTerminalLoop` is the sole owner of presentation state and the sole
writer of terminal bytes. Agent and tool threads only enqueue projected events.
The key decoder only enqueues input actions. No worker, command, or input
handler may write directly to stdout.

### Transcript blocks

The UI represents visible material as ordered blocks, rather than one
tail-truncated text buffer.

| Block | Key | Mutable until | Final behavior |
| --- | --- | --- | --- |
| user | accepted input id | immediately | append-only |
| assistant | model request id | `model.response_committed` or aborted | live delta updates, then append-only |
| thinking | model request id | next non-thinking model phase | live delta updates, then append-only |
| tool | tool call id | `tool.finished` | live status/error updates, then append-only |
| notice | event id | immediately | append-only |

The full ordered block sequence is always retained in the renderer's line
model. UI memory may retain an explicit bounded cache only if it never removes
terminal scrollback or changes an already rendered history block.

### Render frames and scrollback

For every UI state change, the renderer produces a complete ordered line frame:

```text
frozen history blocks
mutable assistant/tool blocks
editor top rule
editor lines and cursor marker
editor bottom rule
completion overlay (only if candidates exist)
footer
```

The renderer compares the frame to `previous_lines`:

- If all changed lines are newly appended, it writes them after `\r\n`; the
  terminal scrollback receives them naturally.
- If an active block, editor, completion list, or footer changes, it moves the
  cursor to the first changed logical row, clears/repaints only the changed
  range, and restores the editor cursor.
- It never implements a `lines[-N:]` transcript viewport. Terminal scrolling is
  native terminal scrolling.
- On width/height change, it reflows lines and performs a bounded full redraw
  of the interactive tail while preserving already completed scrollback.

The renderer maintains `previous_lines`, terminal width/height, logical cursor
row, hardware cursor row, and the greatest previously rendered row. It uses
ANSI cursor movement and erase-line commands, wrapped in synchronized output
when the terminal accepts it. Unsupported synchronization sequences are safely
ignored by normal terminals.

### Input and commands

The persistent session leaves `prompt_toolkit.Application`. A raw/cbreak input
reader decodes printable characters, Enter, Alt+Enter, arrows, Tab, Ctrl+C,
and Ctrl+D into `InputAction` values.

`EditorState` owns the text buffer, cursor, editing history, and selected
completion. The UI loop renders it as the active tail. On submission it first
freezes and appends the user block, then invokes the existing non-blocking CLI
enqueue callback. Routing and agent execution remain unchanged.

Slash candidates are an active overlay with exactly their candidate row count;
they disappear immediately after selection, submit, or context loss. They are
not a flexible terminal pane and cannot consume unused screen height.

### Event-to-block lifecycle

```text
submit input             → append frozen user block
model.request_started    → create mutable assistant block for request_id
model.text_delta         → extend that request's mutable assistant block
tool.started/finished    → create/update mutable tool block
response_committed       → freeze assistant block
response_aborted/failed  → freeze partial block and append status notice
```

Correlations use the existing `request_id` and `tool_call_id`; a new request
cannot mutate a block owned by a previous request.

## File-level changes

| File | Change |
| --- | --- |
| `src/laohuangcode/terminal_screen.py` | New ANSI regular-screen differential renderer and terminal capability adapter. |
| `src/laohuangcode/terminal_editor.py` | New raw input decoder, editor/history state, and completion state. |
| `src/laohuangcode/terminal_ui.py` | Reduce projected events into ordered blocks and drive the unified loop; remove transcript tail slicing and direct `Console` writes in persistent mode. |
| `src/laohuangcode/terminal_input.py` | Retain only the one-shot `PiInputSession`; remove `PiTerminalApplication` from the persistent path. |
| `src/laohuangcode/cli.py` | Start/stop the unified terminal loop while retaining its coordinator queue and existing session lifecycle. |
| `src/laohuangcode/terminal_markdown.py` | Keep its in-memory Markdown-to-terminal-lines role; expose line-oriented output to the screen renderer if needed. |
| `tests/test_terminal_ui.py` | Cover blocks, append-only history, deltas, command overlays, resize, and only-one-writer behavior. |
| `tests/test_cli.py` | Cover session shutdown and queued input through the new terminal loop. |

## Failure handling

- Restore terminal mode and show the hardware cursor in `finally`, including
  keyboard interrupt, EOF, renderer error, and agent shutdown timeout.
- A terminal write failure (including broken pipe) terminates the UI loop
  cleanly and lets the CLI return a nonzero status rather than leaving an input
  reader or renderer thread alive.
- Width fallback is 80 columns when the terminal cannot report a valid size.
- Terminal control sequences from model or tool output remain sanitized before
  reaching the renderer.

## Acceptance criteria

1. After two completed conversations, both user messages and both responses
   remain visible through normal terminal scrollback; no history is erased or
   tail-truncated by laoHuangCode.
2. Streaming the second answer does not change any cells belonging to the
   frozen first answer.
3. The editor stays compact: its height equals wrapped input rows; completion
   height equals currently visible candidates; neither expands into free space.
4. Slash completion remains visible while typing and accepts selection by Tab
   or Enter.
5. Ctrl+C cancels an active task; Ctrl+D exits only with an empty editor and no
   active task.
6. All production interactive stdout writes originate from the unified UI loop.
7. Existing non-interactive/pipe output remains append-only and unchanged.
8. Full test suite, compilation, and diff checks pass.

## Migration order

1. Add focused failing tests for two-turn scrollback and active-block-only
   updates.
2. Implement line/frame data types and ANSI renderer with a fake terminal test
   adapter.
3. Implement editor/raw-input state and connect it to a single UI loop.
4. Move `TerminalUI` event projection and block lifecycle onto the loop.
5. Switch CLI persistent startup to the new loop, then delete the old
   `PiTerminalApplication` persistent route.
6. Run resize, completion, cancellation, shutdown, pipe-mode, and full-suite
   regressions.
