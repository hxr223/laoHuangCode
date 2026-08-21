# Pi Regular Terminal Source-Behavior Port Plan

> Required workflow: use `superpowers:subagent-driven-development` for
> implementation tasks. This plan replaces the earlier Pi-style approximation
> plan; completed historical commits remain useful context but are not the
> acceptance target.

**Goal:** Port Pi's regular-terminal TUI engine behavior into laoHuangCode's
Python terminal layer without changing laoHuangCode's Agent, tool, model,
event, or CLI coordinator architecture.

**Spec:** `docs/superpowers/specs/2026-08-20-pi-regular-terminal-design.md`

**Reference root:**
`/Users/huangxurui/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist`

## Global Constraints

- This is a Pi source-behavior port. "Pi-style" visual approximation is not an
  acceptable implementation strategy.
- Python may not execute or vendor Pi's TypeScript runtime, but must port the
  relevant terminal-engine state, state transitions, and edge-case behavior.
- Preserve laoHuangCode's `AgentSession`, model stream, tool execution,
  command routing, event envelopes, Web logging, CLI coordinator queue, and
  non-TTY `PlainEventSink`.
- Persistent interactive sessions must not use `prompt_toolkit.Application` or
  a tail-truncated transcript viewport.
- The unified UI loop remains the only production interactive stdout writer.
- Keep `PiInputSession` and prompt-toolkit for one-shot setup prompts.
- Verification command: `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -q`,
  then `PYTHONPATH=src .venv/bin/python -m compileall -q src`, then
  `git diff --check`.

## File Structure

| File | Responsibility |
| --- | --- |
| `docs/superpowers/specs/2026-08-20-pi-regular-terminal-design.md` | Binding port requirements. |
| `docs/superpowers/specs/2026-08-20-pi-regular-terminal-parity-matrix.md` | Source-to-target behavior map used by implementers and reviewers. |
| `.superpowers/sdd/2026-08-20-pi-regular-terminal-mode/progress.md` | Ignored execution ledger for SDD coordination. |
| `src/laohuangcode/terminal_screen.py` | Pi `TUI.doRender()` and `positionHardwareCursor()` behavior port. |
| `src/laohuangcode/terminal_editor.py` | Pi `StdinBuffer`, keyboard negotiation filtering, and existing editor action mapping. |
| `src/laohuangcode/terminal_ui.py` | Adapter from laoHuangCode transcript/editor state to rendered lines; loop integration. |
| `src/laohuangcode/terminal_markdown.py` | Markdown/ANSI line output using Pi-compatible visible-width safety. |
| `tests/terminal_emulator.py` | Test-only terminal semantics emulator for viewport, scrolling, cursor movement, and autowrap. |
| `tests/test_terminal_screen.py` | Renderer source-behavior parity tests. |
| `tests/test_terminal_editor.py` | Stdin buffer, terminal-response filtering, paste, and editor action tests. |
| `tests/test_terminal_ui.py` | Integration regressions for scrollback, active tail, completion shrink, and one-writer behavior. |
| `tests/test_cli.py` | Persistent lifecycle and pipe-path regressions. |

## Task 0: Replace Approximation Plan With Source-Behavior Port Contract

**Files:**
- Modify: `docs/superpowers/specs/2026-08-20-pi-regular-terminal-design.md`
- Modify: `docs/superpowers/plans/2026-08-20-pi-regular-terminal-mode.md`
- Create: `docs/superpowers/specs/2026-08-20-pi-regular-terminal-parity-matrix.md`
- Modify: `.superpowers/sdd/2026-08-20-pi-regular-terminal-mode/progress.md`

**Steps:**

1. Rewrite the spec so the binding requirement is Pi source-behavior port, not
   Pi-style approximation.
2. Explicitly record that laoHuangCode architecture above the terminal engine
   is out of scope for Pi migration.
3. Read Pi `tui.js`, `terminal.js`, `stdin-buffer.js`, `keys.js`, and
   `utils.js`.
4. Produce a tracked parity matrix with columns:
   `Pi source`, `Pi behavior/state`, `Python target`, `Regression test`.
5. Update the SDD ledger with the new ruling that previous Tasks 1-6 are
   historical scaffolding, while this plan revision is the current authority.
6. Run `git diff --check`.
7. Commit with message:
   `docs(tui): require pi source-behavior terminal port`

**Acceptance:**

- The spec forbids "Pi-style" as an implementation strategy.
- The plan starts with source-behavior port tasks.
- The parity matrix is concrete enough for implementers to use without reading
  the whole previous conversation.

## Task 1: Add Terminal Semantics Test Emulator

**Files:**
- Create: `tests/terminal_emulator.py`
- Modify: `tests/test_terminal_screen.py`
- Modify: `tests/test_terminal_ui.py`

**Consumes:** Task 0 parity matrix.

**Produces:** A test-only terminal emulator that catches real-terminal bugs
byte-only tests miss.

**Steps:**

1. Implement a small ANSI terminal emulator for tests.
2. Support terminal size, cursor row/column, viewport top, scrollback, bottom
   scrolling, pending autowrap, `CSI A/B/C/G/H`, `ESC[2K`, `ESC[2J`, `ESC[3J`,
   home, synchronized-output wrappers as no-ops, CR, LF, and CRLF.
3. Add tests proving the emulator reproduces bottom scroll when writing at the
   final row and autowrap after a full-width line.
4. Add failing renderer/UI regressions:
   - editor `a` -> `as` in 4 rows does not append prompt history;
   - full-width separator rows do not create duplicated prompts;
   - completion shrink clears stale rows without clearing scrollback.
5. Run focused tests:
   `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_screen tests.test_terminal_ui -v`
6. Commit with message:
   `test(tui): add terminal semantics emulator`

**Acceptance:**

- At least one test would have failed for the screenshot regression where
  repeated typing appended prompt lines.
- Tests validate rendered terminal state, not only byte substrings.

## Task 2: Port Pi Renderer Viewport and Hardware Cursor Model

**Files:**
- Modify: `src/laohuangcode/terminal_screen.py`
- Modify: `tests/test_terminal_screen.py`
- Modify: `tests/test_terminal_ui.py`

**Consumes:** Pi `tui.js` `doRender()` and `positionHardwareCursor()`.

**Produces:** Python renderer with Pi-equivalent viewport and cursor state.

**Steps:**

1. Add renderer fields equivalent to Pi:
   `previous_width`, `previous_height`, `previous_viewport_top`, `cursor_row`,
   `hardware_cursor_row`, `max_lines_rendered`, and clear-on-shrink state.
2. Replace the current simplified `_append` / `_rewrite` flow with a
   `do_render` flow matching Pi:
   - first render full output without clear;
   - width change full render with clear;
   - height change full render with clear unless ruled otherwise;
   - clear-on-shrink behavior;
   - `first_changed` / `last_changed`;
   - `append_start`;
   - deleted-line clearing;
   - viewport-bound fallback full render;
   - controlled scroll when target row is below viewport bottom;
   - synchronized output wrappers.
3. Port `positionHardwareCursor()` semantics, keeping the editor cursor
   visible/hidden behavior compatible with laoHuangCode's current UX.
4. Validate visible width before writing non-image lines.
5. Preserve `TerminalDriver` public shape unless a test-driven change requires
   it.
6. Run focused tests:
   `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_screen tests.test_terminal_ui -v`
7. Commit with message:
   `fix(tui): port pi viewport renderer model`

**Acceptance:**

- Renderer state fields and transitions correspond to Pi `tui.js`.
- Terminal emulator tests pass for small-height, full-width, append, shrink,
  and cursor-only updates.
- Existing scrollback and one-writer tests still pass.

## Task 3: Port Pi Stdin Buffer and Terminal-Response Filtering

**Files:**
- Modify: `src/laohuangcode/terminal_editor.py`
- Modify: `src/laohuangcode/terminal_ui.py`
- Modify: `tests/test_terminal_editor.py`
- Modify: `tests/test_terminal_ui.py`

**Consumes:** Pi `stdin-buffer.js`, `terminal.js`, and relevant `keys.js`
sequence behavior.

**Produces:** Buffered input pipeline before editor actions.

**Steps:**

1. Add a Python `StdinBuffer` equivalent that emits complete sequences and
   paste events.
2. Support CSI, OSC, DCS, APC, SS3, meta-key, doubled-escape, bracketed paste,
   and unmodified Kitty printable duplicate suppression.
3. Add keyboard protocol negotiation filtering equivalent to Pi:
   - parse `ESC[?Nu` Kitty flags;
   - parse `ESC[?...\x63` device attributes;
   - hold prefixes such as `ESC[` and `ESC[?1;` pending before forwarding.
4. Add bracketed-paste start/close lifecycle and modifyOtherKeys close restore
   behavior to the raw loop or terminal driver.
5. Add Apple Terminal Shift+Enter normalization where platform detection
   applies.
6. Filter or map Kitty release/repeat events according to Pi policy.
7. Feed only filtered complete sequences into `RawInputDecoder`.
8. Keep existing editor actions and command completion behavior stable.
9. Add tests for split `ESC` + `[?1;2c`, split bracketed paste, ordinary arrow
   keys, standalone Escape timeout, CJK insert, paste with newlines,
   bracketed-paste lifecycle, modifyOtherKeys restore, Apple Shift+Enter, and
   Kitty release/repeat.
10. Run focused tests:
   `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_editor tests.test_terminal_ui -v`
11. Commit with message:
   `fix(tui): port pi stdin buffering`

**Acceptance:**

- Terminal response fragments cannot appear as inserted text.
- Bracketed paste wrappers are not inserted into the editor.
- Existing shortcut behavior remains compatible.

## Task 4: Port Visible Width, Truncation, and Line Safety

**Files:**
- Modify: `src/laohuangcode/terminal_markdown.py`
- Modify: `src/laohuangcode/terminal_ui.py`
- Modify: `src/laohuangcode/terminal_screen.py`
- Modify: `tests/test_terminal_markdown.py`
- Modify: `tests/test_terminal_ui.py`
- Modify: `tests/test_terminal_screen.py`

**Consumes:** Pi `utils.js` visible-width and truncation behavior.

**Produces:** Line generation that does not rely on terminal autowrap.

**Steps:**

1. Add Python visible-width helpers that ignore ANSI SGR, OSC, DCS, APC, and
   other terminal control sequences.
2. Route Markdown, transcript cards, footer, completion rows, and separators
   through visible-width truncation/wrapping.
3. Ensure no rendered line exceeds terminal width by visible cells.
4. Keep ordinary assistant text on terminal default foreground.
5. Add tests for ANSI-styled text width, CJK width, OSC removal/preservation
   policy, full-width separator safety, and long footer truncation.
6. Run focused tests:
   `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_markdown tests.test_terminal_ui tests.test_terminal_screen -v`
7. Commit with message:
   `fix(tui): port pi terminal width safety`

**Acceptance:**

- Renderer validation never accepts an over-width non-image line.
- Full-width separators and styled lines do not trigger autowrap regressions.

## Task 5: Integration, Manual Real-TTY Checklist, and Final Review

**Files:**
- Modify: `README.md`
- Modify: tests as needed
- Modify: `.superpowers/sdd/2026-08-20-pi-regular-terminal-mode/progress.md`

**Consumes:** Tasks 1-4.

**Produces:** Acceptance coverage and manual verification instructions.

**Steps:**

1. Add or update README manual real-TTY checklist for:
   - repeated typing `asdf...`;
   - CJK input and cursor;
   - slash completion open/shrink;
   - two completed turns in scrollback;
   - terminal resize;
   - Ctrl+C/Ctrl+D;
   - pipe mode.
2. Run full verification:
   - `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -q`
   - `PYTHONPATH=src .venv/bin/python -m compileall -q src`
   - `git diff --check`
3. Dispatch final whole-branch review with the SDD review package.
4. Address final-review findings with one fix wave, or ledger rulings for any
   parked residuals according to the SDD process.
5. Commit final fixes with an appropriate `fix(tui): ...` or `test(tui): ...`
   message.

**Acceptance:**

- Full automated verification passes.
- Manual checklist covers the user-reported failures.
- The final reviewer has the parity matrix and ledger context.
