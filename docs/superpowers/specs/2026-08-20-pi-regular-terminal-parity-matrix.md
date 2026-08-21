# Pi TUI Source-Behavior Parity Matrix

Plan: `docs/superpowers/plans/2026-08-20-pi-regular-terminal-mode.md`

Reference root:
`/Users/huangxurui/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist`

This matrix is the implementation map for the source-behavior port. It maps
Pi terminal-engine behavior to Python targets and required regression coverage.

## Renderer

| Pi source | Pi behavior/state | Python target | Regression test |
| --- | --- | --- | --- |
| `tui.js:TUI.doRender()` | Reads terminal `columns` and `rows` every render. | `PiMainScreenRenderer.render()` reads `TerminalDriver.get_size()` each render. | Resize tests in `tests/test_terminal_screen.py` verify width/height paths. |
| `tui.js:TUI.previousLines` | Stores previous full logical frame. | `PiMainScreenRenderer._previous_lines`. | Changed-range tests assert frozen first response is not rewritten. |
| `tui.js:TUI.previousWidth` / `previousHeight` | Detects width and height changes separately. | New `_previous_width`, `_previous_height` or expanded `_previous_size` with separate logic. | Width change emits full render with clear; height change follows documented clear path. |
| `tui.js:TUI.previousViewportTop` | Tracks which logical row is at top of visible viewport. | New `_previous_viewport_top`. | Small-height emulator tests prove cursor movement does not assume offscreen rows are reachable. |
| `tui.js:TUI.cursorRow` | Tracks logical end-of-content row for viewport calculations. | New `_cursor_row`. | Append and deletion tests verify viewport state after content grows/shrinks. |
| `tui.js:TUI.hardwareCursorRow` | Tracks actual terminal cursor row separately from logical end row. | Rename/replace `_hardware_row` with `_hardware_cursor_row` using Pi semantics. | Cursor-only update and IME cursor placement tests verify row movement from actual hardware row. |
| `tui.js:TUI.maxLinesRendered` | Tracks working area for shrink clearing. | Existing `_max_rows`, renamed or behavior-aligned to `_max_lines_rendered`. | Completion shrink clears stale rows without clearing scrollback. |
| `tui.js:computeLineDiff()` | Computes movement from actual hardware row and viewport, not raw logical delta. | Helper in `terminal_screen.py`. | Emulator test where first changed row is visible but logical row differs from hardware row. |
| `tui.js:fullRender(false)` | First render writes all lines without clearing screen or scrollback. | `_full_render(clear=False)`. | First render test asserts no `ESC[2J` or `ESC[3J`. |
| `tui.js:fullRender(true)` | Width/height/shrink fallback clears viewport and scrollback using `ESC[2J ESC[H ESC[3J`. | `_full_render(clear=True)` scoped to Pi parity; any scrollback-preservation deviation must be ruled in ledger. | Width and height change tests assert exact clear path or ledgered divergence. |
| `tui.js:firstChanged/lastChanged` | Computes changed span over `max(previous,new)` using empty string for missing rows. | `_changed_range()` returning inclusive or half-open range, documented. | Editor-only change repaints one row; deleted-row change clears stale rows. |
| `tui.js:appendStart` | Appended lines after existing content move to previous end then `CRLF`. | `_render_diff()` append-start branch. | Completed block append enters scrollback once; ordinary keystroke never uses append path. |
| `tui.js:firstChanged < prevViewportTop` | Full render if diff starts above current visible viewport. | Fallback branch in renderer. | Small-height emulator test where old history is offscreen and active tail changes. |
| `tui.js:moveTargetRow > prevViewportBottom` | Scrolls controlled amount and updates `prevViewportTop` and `viewportTop`. | Controlled-scroll branch in renderer. | Emulator test verifies no duplicated prompt while appending below bottom. |
| `tui.js:buffer = ESC[?2026h ... ESC[?2026l` | Wraps diff/full buffers in synchronized output. | Single pending buffer emitted once per render with sync wrappers. | Byte tests assert wrappers around changed render output. |
| `tui.js:deleted lines branch` | Clears extra rows without triggering scroll when new frame shrinks. | Deleted-only branch in renderer. | Completion overlay shrinks from N rows to 0 without stale rows. |
| `tui.js:visibleWidth(line) > width` | Throws/logs on over-width non-image line. | Renderer validation using Python visible-width helper. | Over-width ANSI/CJK line raises renderer error before writing. |
| `tui.js:positionHardwareCursor()` | Moves from current hardware row to target row, uses `CSI {col+1}G`, updates hardware row, hides/shows cursor. | `_position_hardware_cursor()`. | CJK cursor, cursor-only updates, and no-content cursor hide/show tests. |

## Terminal Input and Keyboard Negotiation

| Pi source | Pi behavior/state | Python target | Regression test |
| --- | --- | --- | --- |
| `stdin-buffer.js:isCompleteSequence()` | Classifies escape, CSI, OSC, DCS, APC, SS3, meta, incomplete sequences. | New `StdinBuffer` in `terminal_editor.py` or adjacent module. | Split CSI/OSC/DCS/APC/SS3 tests emit only complete sequences. |
| `stdin-buffer.js:isCompleteCsiSequence()` | CSI completes on final byte `0x40..0x7e`; SGR mouse is special. | `StdinBuffer._is_complete_csi()`. | `ESC[` waits; `ESC[A` emits one up sequence; `ESC[?1;2c` emits complete DA. |
| `stdin-buffer.js:isCompleteOscSequence()` | OSC completes on BEL or ST. | `StdinBuffer._is_complete_osc()`. | Split OSC does not leak text. |
| `stdin-buffer.js:isCompleteDcsSequence()` | DCS completes on ST. | `StdinBuffer._is_complete_dcs()`. | Split DCS response does not leak text. |
| `stdin-buffer.js:isCompleteApcSequence()` | APC completes on ST. | `StdinBuffer._is_complete_apc()`. | Split APC response does not leak text. |
| `stdin-buffer.js:extractCompleteSequences()` | Splits buffered input into complete sequences, preserving remainder. | `StdinBuffer.process()` internal splitter. | Batched `a ESC[A b` emits insert/action/insert in order. |
| `stdin-buffer.js:doubled ESC handling` | `ESC ESC [` emits first escape and restarts new sequence. | Same special case. | `b"\x1b\x1b[27;1:3u"` does not insert `[27...`. |
| `stdin-buffer.js:BRACKETED_PASTE_START/END` | Enters paste mode and emits paste content atomically. | `StdinBuffer` paste event converted to insert/newline actions. | Split paste wrappers insert only content. |
| `stdin-buffer.js:pendingKittyPrintableCodepoint` | Suppresses duplicate raw printable after unmodified Kitty printable sequence. | Same pending codepoint state. | Kitty printable + raw duplicate inserts one character. |
| `terminal.js:parseKeyboardProtocolNegotiationSequence()` | Parses `ESC[?Nu` and device attributes `ESC[?...c`. | Python parser before `RawInputDecoder`. | `ESC[?7u` and `ESC[?1;2c` are filtered from editor. |
| `terminal.js:isKeyboardProtocolNegotiationSequencePrefix()` | Holds prefixes `ESC[` and `ESC[?...` pending. | Negotiation buffer with timeout. | Split `ESC[` then `?1;2c` filters complete response. |
| `terminal.js:readKeyboardProtocolNegotiationSequence()` | Combines buffered prefix with next sequence before forwarding. | `TerminalInputFilter.process_sequence()`. | Fragmented DA response cannot insert `[?...`. |
| `terminal.js:queryAndEnableKittyProtocol()` | Enables stdin buffer, requests Kitty protocol, uses DA fallback. | `_StdTerminalDriver` startup or `InteractiveTerminalLoop` input setup. | Startup writes bracketed paste enable and keyboard query where supported or documented. |
| `terminal.js:enableModifyOtherKeys()` / `disableModifyOtherKeys()` | Enables xterm modifyOtherKeys fallback when Kitty is unavailable and restores it on close. | `_StdTerminalDriver` or loop lifecycle state. | Close writes restore sequence and leaves no keyboard protocol mode active. |
| `terminal.js:bracketed paste enable` | Writes `ESC[?2004h` on start and disables it on close. | `_StdTerminalDriver.enter_raw_mode()` / `restore()` or loop start/close. | Start/close lifecycle test observes `?2004h` and `?2004l`. |
| `terminal.js:normalizeAppleTerminalInput()` | On Apple Terminal, Shift+Enter is normalized to `ESC[13;2u`. | Platform-aware normalization before `RawInputDecoder`. | Apple Terminal Shift+Enter maps to newline, not submit. |
| `keys.js:parseKey()` / `matchesKey()` | Maps complete sequences to semantic key IDs including Kitty and modifyOtherKeys. | `RawInputDecoder` consumes complete sequences and emits existing `InputActionKind`. | Enter, Shift/Alt Enter, arrows, Tab, Backspace, Ctrl+C, Ctrl+D remain stable. |
| `keys.js:isKeyRelease()` / `isKeyRepeat()` | Kitty release/repeat events are distinguished from ordinary key presses. | `RawInputDecoder` filters or maps events according to Pi policy. | `ESC[65;1:3u` release does not insert text; paste content containing `:3u` remains literal. |
| `keys.js:decodePrintableKey()` | Decodes Kitty/modifyOtherKeys printable sequences. | Printable sequence handling before UTF-8 insert. | Printable CSI-u inserts expected character once. |

## Width and Line Safety

| Pi source | Pi behavior/state | Python target | Regression test |
| --- | --- | --- | --- |
| `utils.js:visibleWidth()` | Fast ASCII path; strips supported ANSI/OSC/APC; expands tabs to width 3; segments graphemes. | Python `visible_width()` helper. | ANSI SGR, OSC, tab, CJK, emoji width tests. |
| `utils.js:extractAnsiCode()` | Parses terminal control sequences so width ignores them. | Python ANSI/control parser. | Styled assistant/tool lines measure visible cells only. |
| `utils.js:normalizeTerminalOutput()` | Normalizes Thai/Lao AM vowels and tabs outside terminal strings. | Python normalizer or ledgered minimal equivalent. | Tabs do not trigger terminal tab-stop wrapping. |
| `utils.js:truncateToWidth()` | Truncates by visible columns while preserving ANSI resets. | Python `truncate_to_width()`. | Long footer/card rows stay within terminal width with ANSI styles. |
| `utils.js:wrapTextWithAnsi()` | Wraps styled text without breaking ANSI state. | Markdown/transcript wrapping in `terminal_markdown.py` / `terminal_ui.py`. | Styled Markdown wraps without over-width rows. |
| `utils.js:applyBackgroundToLine()` | Pads/stylizes background to exact visible width. | `_background_lines()` using visible-width padding. | Tool/user cards exact width, no autowrap. |

## laoHuangCode Adapter Boundary

| Pi source | Pi behavior/state | Python target | Regression test |
| --- | --- | --- | --- |
| Pi renderer consumes component-rendered full line array. | Upstream app provides full logical line sequence; renderer owns terminal diff. | `TerminalUI.build_frame()` remains the adapter from blocks/editor to `ScreenFrame`. | Existing block lifecycle tests plus terminal emulator integration. |
| Pi TUI owns terminal writes. | Only one writer enters stdout during live TUI. | `InteractiveTerminalLoop` and `PiMainScreenRenderer`; event threads enqueue only. | One-writer tests assert publish/input do not write before drain/run. |
| Pi input handler receives filtered complete sequences. | Terminal responses filtered before component/editor state. | `InteractiveTerminalLoop` feeds `StdinBuffer` then `RawInputDecoder`. | Split terminal response and paste integration tests. |
| Pi terminal lifecycle restores cursor/raw mode. | Live session restores terminal on EOF, interrupt, broken write, shutdown. | `_StdTerminalDriver.restore()` and renderer/loop close. | CLI shutdown and broken pipe tests. |
| Pi Agent/runtime not part of TUI package behavior under port. | laoHuangCode Agent/session/tool stack remains unchanged. | No changes outside terminal files except tests/docs/README. | `tests/test_agent.py`, `tests/test_model_stream.py`, `tests/test_tools.py`, and `tests/test_cli.py` full-suite guard. |
