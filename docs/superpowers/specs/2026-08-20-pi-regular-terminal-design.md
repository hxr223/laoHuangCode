# Pi regular terminal source-behavior port

## Goal

Port Pi's regular-terminal TUI engine behavior into laoHuangCode's Python TUI
layer. This is a source-behavior port, not a visual approximation.

Python must not execute or vendor Pi's TypeScript runtime, but the terminal
engine state, state transitions, input buffering, width handling, and ANSI
output strategy must correspond to the installed Pi implementation.

Forbidden interpretations:

- "Pi-style" as a simplified renderer with similar colors or prompt shape.
- "Behavioral model" as permission to invent a smaller terminal model.
- Byte-recording unit tests as proof of real-terminal correctness.

Required interpretation:

- Treat Pi's TUI source as the reference implementation for the terminal
  engine.
- Reproduce the relevant state fields, state transitions, fallback paths, and
  edge-case handling in Python.
- Keep laoHuangCode's existing Agent, model, tool, command, event, session, and
  provider architecture intact.

## Reference Sources

Installed Pi reference root:

`/Users/huangxurui/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist`

Authoritative source files:

| Pi source | Ported responsibility |
| --- | --- |
| `tui.js` | Regular-screen renderer, viewport tracking, changed-range rendering, cursor restoration, resize behavior, clear-on-shrink behavior, synchronized output. |
| `terminal.js` | Process terminal lifecycle, raw mode, bracketed paste enable/disable, keyboard protocol negotiation, terminal-response filtering. |
| `stdin-buffer.js` | Complete-sequence buffering for CSI, OSC, DCS, APC, SS3, meta keys, bracketed paste, and split escape sequences. |
| `keys.js` | Key sequence interpretation after buffering, including Kitty and modifyOtherKeys forms where applicable. |
| `utils.js` | Visible-width and truncation rules that ignore ANSI/control sequences and avoid terminal autowrap bugs. |

Tracked parity matrix:

`docs/superpowers/specs/2026-08-20-pi-regular-terminal-parity-matrix.md`

Out of scope from Pi:

- Pi's Agent/session/runtime architecture.
- Pi's tool registry, model/provider stack, extension model, image protocols,
  overlay stack, and exported HTML pipeline.
- Mouse support and terminal image rendering, unless a stub is required to
  preserve renderer behavior for non-image lines.

## Architecture Boundary

Only the bottom terminal engine is ported:

```text
laoHuangCode Agent / Events / Tools / Commands
                |
                v
TerminalUI adapter: transcript blocks + editor state -> rendered lines
                |
                v
Pi-port terminal engine:
  - renderer / viewport / hardware cursor
  - stdin buffer / key decoder
  - visible-width utilities
                |
                v
stdin / stdout
```

The following laoHuangCode architecture must remain stable:

- `AgentSession`, model streaming, cancellation, and history commit behavior.
- Event envelopes, `UIEventReducer`, correlations, and Web dashboard logging.
- Built-in tools and command routing.
- CLI coordinator queue and non-TTY `PlainEventSink`.
- `PiInputSession` for one-shot setup prompts.

## Renderer Parity Requirements

The Python renderer must port the relevant behavior of Pi `TUI.doRender()` and
`positionHardwareCursor()`.

Required state fields:

- `previous_lines`
- `previous_width`
- `previous_height`
- `previous_viewport_top`
- `cursor_row`
- `hardware_cursor_row`
- `max_lines_rendered`
- clear-on-shrink state or an explicit equivalent ruling

Required render flow:

1. Read current terminal width and height for every render.
2. Render a full logical line sequence through the laoHuangCode adapter.
3. Validate every non-image line by visible terminal width, ignoring ANSI
   sequences.
4. Compute `width_changed`, `height_changed`, `prev_viewport_top`,
   `viewport_top`, and a `compute_line_diff(target_row)` equivalent.
5. Full render without clearing on first render.
6. Full render with clearing on width change.
7. Full render with clearing on normal height change, except where a documented
   environment-specific ruling says otherwise.
8. Full render with clearing when content shrinks below the working area and the
   selected clear-on-shrink rule requires it.
9. Compute `first_changed` and `last_changed` over the whole line sequence.
10. Detect `append_start` when new lines are appended after existing content.
11. If no content changed, only update hardware cursor position.
12. If changes are deleted lines only, clear extra rows without scrolling.
13. If the first changed row is above the previous viewport, use full render.
14. When `move_target_row` is below the previous viewport bottom, scroll in a
   controlled way and update viewport state.
15. Render only the changed range, wrapped in synchronized output
   `ESC[?2026h` / `ESC[?2026l`.
16. Use cursor movement relative to tracked hardware cursor state, not assumed
   logical row access.
17. Track final render cursor row separately from the restored hardware cursor
   row.
18. Restore the hardware cursor for IME/caret placement after each render.

Required invariants:

- No ordinary editor keystroke may repaint unchanged footer rows or full-width
  rules.
- No ordinary editor keystroke may emit `\r\n` unless Pi's append/scroll path
  would emit it.
- Completed history may enter native scrollback only once.
- Mutable assistant/tool/editor regions may be redrawn; frozen blocks may not.
- A line whose visible width exceeds terminal width is a renderer error, not an
  accepted frame.
- Full-width rules must not rely on terminal autowrap behavior.

## Input Parity Requirements

The Python input layer must port the relevant behavior of Pi `StdinBuffer` and
`ProcessTerminal` keyboard negotiation before editor actions are produced.

Required buffering behavior:

- Buffer partial escape sequences across read chunks.
- Emit complete CSI sequences (`ESC [`).
- Emit complete OSC sequences (`ESC ] ... BEL` or `ESC ] ... ESC \`).
- Emit complete DCS sequences (`ESC P ... ESC \`).
- Emit complete APC sequences (`ESC _ ... ESC \`).
- Emit complete SS3 sequences (`ESC O x`).
- Treat a standalone `ESC` as a complete key only after timeout.
- Preserve Pi's special handling for doubled escape followed by a new escape
  sequence.
- Detect bracketed paste start/end and emit paste content atomically.
- Avoid duplicate printable insertion from unmodified Kitty printable
  codepoints.

Required terminal-response filtering:

- Query/response sequences used for keyboard protocol negotiation must not reach
  the editor as text.
- `ESC[?u`, `ESC[?1;...c`, split prefixes like `ESC[` + `?1;...c`, and related
  device-attribute fragments must be recognized and filtered or delayed exactly
  as Pi does.
- If an incomplete negotiation prefix times out, it may be forwarded only under
  the same policy as Pi.
- The raw loop must enable bracketed paste on start and disable it on close
  with Pi-equivalent lifecycle behavior.
- If modifyOtherKeys fallback is enabled, close must restore it so the terminal
  does not retain keyboard protocol state after laoHuangCode exits.
- Apple Terminal Shift+Enter normalization must match Pi's policy where the
  platform can be detected.
- Kitty key release/repeat events must be filtered or interpreted with the same
  press/repeat policy as Pi; release events must not insert text.

Required editor action compatibility:

- Existing laoHuangCode actions remain: insert, submit, newline, complete,
  history up/down, cursor left/right, backspace, dismiss, cancel, EOF.
- Bracketed paste content inserts as text/newlines, not as literal control
  wrappers.
- Unsupported terminal control responses must never appear in the input buffer
  as fragments like `[? s`.

## Layout and Width Requirements

The adapter from laoHuangCode state to terminal lines must use Pi-compatible
width semantics:

- Visible width ignores ANSI SGR, OSC, DCS, APC, and other control sequences.
- Wrapping and truncation are based on terminal cell width, not Python string
  length.
- CJK and other wide glyphs use terminal cell width.
- Lines must be truncated or wrapped before reaching the renderer; the renderer
  still validates width as a safety gate.
- Ordinary assistant text uses terminal default foreground unless semantic
  styling is required.

## Test Requirements

Byte-recording tests are insufficient. Add a terminal semantics test adapter
that simulates at least:

- cursor row and column
- viewport top and bottom
- bottom scrolling
- `CSI A/B/C/G/H`
- `ESC[2K`
- `ESC[2J`, `ESC[3J`, and home where used by full render
- synchronized output wrappers as no-op wrappers
- autowrap / pending-wrap behavior at the final column
- small terminal heights

Regression scenarios must include:

- editor `a` -> `as` in a 4-row terminal does not append prompt history
- full-width rule lines do not trigger prompt duplication
- completion rows shrink and clear stale rows without clearing scrollback
- frozen first turn is not rewritten while second response streams
- appended completed blocks enter scrollback once
- terminal width change full-renders through the documented clear path
- terminal height change follows the Pi-compatible clear path
- split `ESC` + `[?1;2c` does not insert `[?1;2c`
- split bracketed paste inserts only paste content
- close restores bracketed paste and keyboard protocol modes
- Kitty key release/repeat events do not insert literal CSI-u text
- Apple Terminal Shift+Enter maps to newline where platform detection applies
- CJK cursor position uses terminal cells

## Acceptance Criteria

1. The spec and plan use "Pi source-behavior port" as the binding requirement;
   "Pi-style" appears only when describing previous mistakes or historical
   commits.
2. A parity matrix maps every required Pi behavior above to a Python target and
   at least one regression test.
3. The renderer maintains Pi-equivalent viewport and hardware-cursor state.
4. The input layer buffers and filters terminal sequences before editor actions.
5. A real-terminal semantics test adapter catches bottom-scroll and autowrap
   regressions that byte-only tests miss.
6. Existing laoHuangCode Agent/session/tool/model architecture is unchanged.
7. Non-interactive and pipe output remain append-only and unchanged.
8. Full test suite, compilation, and `git diff --check` pass.
