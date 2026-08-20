# Pi Regular Terminal Mode Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the persistent prompt_toolkit transcript viewport with a Pi-style normal-terminal renderer that keeps completed conversations in terminal scrollback and redraws only live UI content.

**Architecture:** A raw-terminal UI loop owns ordered transcript blocks, editor/completion state, and a previous-lines ANSI renderer. Agent and tool threads enqueue events but never write terminal bytes. PiInputSession remains for one-shot configuration prompts; AgentSession, EventEnvelope, Web trace, and pipe output are unchanged.

**Tech Stack:** Python 3.11+, selectors, termios, tty, os, ANSI VT sequences, Rich in-memory Markdown formatting, CommandRegistry, unittest.

**Spec:** docs/superpowers/specs/2026-08-20-pi-regular-terminal-design.md

## Global Constraints

- Persistent interactive sessions must not use prompt_toolkit.Application or a tail-truncated transcript viewport.
- Completed user, assistant, tool, and notice blocks are append-only history; only unfinished blocks and the editor tail may be redrawn.
- The unified UI loop is the only production interactive stdout writer.
- Preserve AgentSession routing, EventEnvelope ordering, model/tool correlations, Web logging, and non-TTY PlainEventSink behavior.
- Keep prompt-toolkit>=3.0.52,<4 for one-shot setup prompts and add no runtime dependency.
- Restore terminal mode and cursor on all exits; a broken terminal write must terminate the UI loop cleanly and produce a nonzero CLI exit.
- Verification command: PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v, then .venv/bin/python -m compileall -q src and git diff --check.

---

## File structure

| File | Responsibility |
| --- | --- |
| src/laohuangcode/terminal_screen.py | Terminal driver protocol and Pi-style previous-lines ANSI differential renderer. |
| src/laohuangcode/terminal_editor.py | Raw key decoder, editor/history state, and slash completion state. |
| src/laohuangcode/terminal_markdown.py | In-memory Markdown-to-ANSI-line conversion for the frame builder. |
| src/laohuangcode/terminal_ui.py | Ordered transcript blocks, event lifecycle, one UI loop, and frame construction. |
| src/laohuangcode/terminal_input.py | One-shot PiInputSession only; remove PiTerminalApplication. |
| src/laohuangcode/cli.py | Start/stop the UI loop while retaining the existing session coordinator. |
| tests/test_terminal_screen.py | Renderer append/diff/resize/cleanup tests with a fake terminal. |
| tests/test_terminal_editor.py | Key decoding, editing, history, and completion tests. |
| tests/test_terminal_ui.py | Two-turn history, block freezing, streaming, questions, and one-writer tests. |
| tests/test_cli.py | Persistent-session lifecycle and pipe-path regression tests. |

## Interfaces

~~~python
@dataclass(frozen=True, slots=True)
class TerminalSize:
    columns: int
    rows: int

@dataclass(frozen=True, slots=True)
class ScreenFrame:
    lines: tuple[str, ...]
    cursor_row: int
    cursor_column: int

class TerminalDriver(Protocol):
    def size(self) -> TerminalSize: raise NotImplementedError
    def write(self, data: str) -> None: raise NotImplementedError
    def flush(self) -> None: raise NotImplementedError
    def fileno(self) -> int: raise NotImplementedError
    def enter_raw_mode(self) -> ContextManager[None]: raise NotImplementedError
    def restore(self) -> None: raise NotImplementedError

class PiMainScreenRenderer:
    def render(self, frame: ScreenFrame) -> None: raise NotImplementedError
    def close(self, *, preserve_screen: bool = False) -> None: raise NotImplementedError

class InputActionKind(StrEnum):
    INSERT = "insert"
    SUBMIT = "submit"
    NEWLINE = "newline"
    COMPLETE = "complete"
    HISTORY_UP = "history_up"
    HISTORY_DOWN = "history_down"
    CANCEL = "cancel"
    EOF = "eof"

@dataclass(frozen=True, slots=True)
class InputAction:
    kind: InputActionKind
    text: str = ""

@dataclass(frozen=True, slots=True)
class EditorEffect:
    submit: str | None = None
    cancel_requested: bool = False
    exit_requested: bool = False
    notice: str | None = None

class EditorState:
    def apply(self, action: InputAction, *, runtime_active: bool) -> EditorEffect: raise NotImplementedError
    def set_completions(self, values: tuple[CompletionItem, ...]) -> None: raise NotImplementedError
    def render_lines(self, width: int) -> tuple[tuple[str, ...], int, int]: raise NotImplementedError

class InteractiveTerminalLoop:
    def run(self, on_submit: Callable[[str], None]) -> None: raise NotImplementedError
    def publish_event(self, event: Any) -> None: raise NotImplementedError
    def request_exit(self) -> None: raise NotImplementedError
~~~

### Task 1: Build and test the ANSI normal-screen renderer

**Files:**
- Create: src/laohuangcode/terminal_screen.py
- Create: tests/test_terminal_screen.py

**Consumes:** Standard-library terminal capabilities only.

**Produces:** TerminalSize, ScreenFrame, TerminalDriver, MemoryTerminalDriver, and PiMainScreenRenderer. Later tasks submit complete logical frames through render(frame).

- [ ] **Step 1: Write the failing append and active-tail tests**

~~~python
def test_new_completed_lines_append_without_erasing_scrollback(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    renderer = PiMainScreenRenderer(terminal)

    renderer.render(ScreenFrame(("user one", "answer one", "❯ "), 2, 2))
    terminal.clear_writes()
    renderer.render(ScreenFrame(("user one", "answer one", "user two", "❯ "), 3, 2))

    self.assertIn("\r\nuser two", terminal.writes())
    self.assertNotIn("\x1b[2J", terminal.writes())
    self.assertNotIn("\x1b[3J", terminal.writes())

def test_stream_delta_repaints_only_changed_active_tail(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    renderer = PiMainScreenRenderer(terminal)
    renderer.render(ScreenFrame(("user one", "answer one", "answer two: hel", "❯ "), 3, 2))
    terminal.clear_writes()

    renderer.render(ScreenFrame(("user one", "answer one", "answer two: hello", "❯ "), 3, 2))

    self.assertIn("\x1b[2K", terminal.writes())
    self.assertIn("answer two: hello", terminal.writes())
    self.assertNotIn("answer one", terminal.writes())
~~~

- [ ] **Step 2: Run the new tests to prove the red state**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_screen -v

Expected: FAIL with ModuleNotFoundError: No module named laohuangcode.terminal_screen.

- [ ] **Step 3: Implement a fake terminal and append/diff renderer**

~~~python
class PiMainScreenRenderer:
    def __init__(self, terminal: TerminalDriver) -> None:
        self._terminal = terminal
        self._previous_lines: tuple[str, ...] = ()
        self._previous_size: TerminalSize | None = None
        self._hardware_row = 0
        self._max_rows = 0
        self._closed = False

    def render(self, frame: ScreenFrame) -> None:
        if self._closed:
            return
        first = self._first_changed(self._previous_lines, frame.lines)
        if first is None:
            self._place_cursor(frame)
            return
        if first == len(self._previous_lines):
            self._append(frame.lines[first:])
        else:
            self._rewrite(first, frame.lines)
        self._previous_lines = frame.lines
        self._max_rows = max(self._max_rows, len(frame.lines))
        self._place_cursor(frame)
        self._terminal.flush()
~~~

Implement _append with carriage-return/newline before every appended line after the first. Implement _rewrite with cursor movement, erase-line sequence ESC[2K, and only the changed range. Never emit ESC[2J or ESC[3J during ordinary updates.

- [ ] **Step 4: Add resize and cleanup tests, then implement their behavior**

~~~python
def test_resize_never_clears_scrollback(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    renderer = PiMainScreenRenderer(terminal)
    renderer.render(ScreenFrame(("saved history", "active", "❯ "), 2, 2))
    terminal.resize(columns=40, rows=24)
    terminal.clear_writes()

    renderer.render(ScreenFrame(("saved history", "active", "❯ "), 2, 2))

    self.assertNotIn("\x1b[3J", terminal.writes())

def test_close_restores_driver_and_cursor(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    renderer = PiMainScreenRenderer(terminal)
    renderer.close()

    self.assertTrue(terminal.restored)
    self.assertIn("\x1b[?25h", terminal.writes())
~~~

Cache terminal size. On size change redraw only rows under renderer control; preserve earlier scrollback. close() is idempotent, shows the cursor, and calls driver.restore() exactly once.

- [ ] **Step 5: Run tests and commit**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_screen -v

Expected: PASS.

~~~bash
git add src/laohuangcode/terminal_screen.py tests/test_terminal_screen.py
git commit -m "feat(tui): add pi-style regular screen renderer"
~~~

### Task 2: Move editor and completion behavior out of prompt_toolkit

**Files:**
- Create: src/laohuangcode/terminal_editor.py
- Modify: src/laohuangcode/commands.py
- Create: tests/test_terminal_editor.py
- Modify: tests/test_commands.py

**Consumes:** Existing CommandRegistry and CommandSpec.

**Produces:** RawInputDecoder, EditorState, CompletionItem, and CommandRegistry.complete(text, state). The UI loop consumes EditorEffect and render_lines(width).

- [ ] **Step 1: Write failing decoder, editor, and completion tests**

~~~python
def test_decoder_distinguishes_submit_alt_enter_and_ctrl_d(self):
    decoder = RawInputDecoder()
    self.assertEqual(decoder.feed(b"\r"), (InputAction(InputActionKind.SUBMIT),))
    self.assertEqual(decoder.feed(b"\x1b\r"), (InputAction(InputActionKind.NEWLINE),))
    self.assertEqual(decoder.feed(b"\x04"), (InputAction(InputActionKind.EOF),))

def test_editor_keeps_slash_candidates_and_tab_accepts_first(self):
    editor = EditorState()
    registry = CommandRegistry((CommandSpec("/exit", "退出程序", "/exit"),))
    editor.apply(InputAction(InputActionKind.INSERT, "/e"), runtime_active=False)
    editor.set_completions(registry.complete(editor.text, state="IDLE"))

    effect = editor.apply(InputAction(InputActionKind.COMPLETE), runtime_active=False)

    self.assertEqual(editor.text, "/exit")
    self.assertIsNone(effect.submit)

def test_editor_submit_records_history(self):
    editor = EditorState()
    editor.apply(InputAction(InputActionKind.INSERT, "first"), runtime_active=False)

    effect = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)

    self.assertEqual(effect.submit, "first")
    self.assertEqual(editor.history, ("first",))
~~~

- [ ] **Step 2: Run tests to prove the red state**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_editor tests.test_commands -v

Expected: FAIL because terminal_editor and CommandRegistry.complete do not exist.

- [ ] **Step 3: Add a prompt-toolkit-independent completion API**

~~~python
@dataclass(frozen=True, slots=True)
class CompletionItem:
    value: str
    description: str
    start: int

def complete(self, text: str, *, state: str) -> tuple[CompletionItem, ...]:
    """Return slash command and argument candidates without prompt_toolkit."""
~~~

Reuse existing command-name matching, argument completers, state restrictions, and the /model current exception. Adapt these values in CommandCompleter.get_completions() so one-shot prompts keep their current behavior.

- [ ] **Step 4: Implement raw key handling and editor state**

~~~python
class EditorState:
    def apply(self, action: InputAction, *, runtime_active: bool) -> EditorEffect:
        if action.kind is InputActionKind.SUBMIT:
            return self._submit()
        if action.kind is InputActionKind.NEWLINE:
            self._insert("\n")
            return EditorEffect()
        if action.kind is InputActionKind.CANCEL:
            return self._cancel_or_clear(runtime_active)
        if action.kind is InputActionKind.EOF:
            return self._exit_or_notice(runtime_active)
        return self._apply_edit_action(action)

    def render_lines(self, width: int) -> tuple[tuple[str, ...], int, int]:
        """Return wrapped editor rows and cursor, with ❯ and continuation prefixes."""
~~~

RawInputDecoder buffers incomplete escape sequences and emits insert, arrows, Tab, Backspace, Ctrl+C, Ctrl+D, Enter, and Alt+Enter actions. EditorState owns text, cursor, history index, selected completion, and completion visibility. A non-slash edit, selection, or submission closes completion.

- [ ] **Step 5: Run tests and commit**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_editor tests.test_commands -v

Expected: PASS.

~~~bash
git add src/laohuangcode/terminal_editor.py src/laohuangcode/commands.py \
  tests/test_terminal_editor.py tests/test_commands.py
git commit -m "feat(tui): add raw editor and command completion state"
~~~

### Task 3: Convert transcript data into append-only blocks and line frames

**Files:**
- Modify: src/laohuangcode/terminal_markdown.py
- Modify: src/laohuangcode/terminal_ui.py
- Modify: tests/test_terminal_ui.py

**Consumes:** PiMainScreenRenderer logical-line contract, TerminalTheme, UIEventReducer, and existing event correlations.

**Produces:** TranscriptBlock, TerminalUI.accept_user_input(), TerminalUI.apply_projected_event(), TerminalUI.build_history_lines(), and TerminalUI.build_frame().

- [ ] **Step 1: Write failing two-turn and freeze tests**

~~~python
def event(kind: str, correlation_id: str, **payload: object) -> dict[str, object]:
    return {"kind": kind, "correlation_id": correlation_id, "payload": payload}

def test_two_completed_turns_remain_in_history_without_tail_truncation(self):
    ui = TerminalUI(theme="light")
    ui.accept_user_input("first question")
    ui.apply_projected_event(event("model.text_delta", "r1", text="first answer"))
    ui.apply_projected_event(event("model.response_committed", "r1"))
    ui.accept_user_input("second question")
    ui.apply_projected_event(event("model.text_delta", "r2", text="second answer"))

    rendered = "\n".join(ui.build_history_lines(width=80))
    self.assertIn("first question", rendered)
    self.assertIn("first answer", rendered)
    self.assertIn("second question", rendered)
    self.assertIn("second answer", rendered)

def test_second_request_cannot_mutate_frozen_first_response(self):
    ui = TerminalUI(theme="dark")
    ui.apply_projected_event(event("model.text_delta", "r1", text="one"))
    ui.apply_projected_event(event("model.response_committed", "r1"))
    ui.apply_projected_event(event("model.text_delta", "r2", text="two"))

    self.assertEqual(ui.block_for("assistant", "r1").text, "one")
    self.assertEqual(ui.block_for("assistant", "r2").text, "two")
~~~

- [ ] **Step 2: Run focused tests to prove the red state**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui.TerminalUITests.test_two_completed_turns_remain_in_history_without_tail_truncation tests.test_terminal_ui.TerminalUITests.test_second_request_cannot_mutate_frozen_first_response -v

Expected: FAIL because these block/frame methods do not exist and persistent rendering still slices the latest visible lines.

- [ ] **Step 3: Add Markdown ANSI line output**

~~~python
def render_markdown_lines(text: str, width: int, theme: TerminalTheme) -> tuple[str, ...]:
    """Return Rich-rendered ANSI logical lines without terminal I/O."""
~~~

Reuse the in-memory Rich console. Preserve formatting escape sequences, strip OSC-8 hyperlinks, and return lines without a trailing newline. Retain render_markdown() as a compatibility adapter while one-shot prompt code calls it.

- [ ] **Step 4: Implement block lifecycle keyed by correlation**

~~~python
@dataclass(slots=True)
class TranscriptBlock:
    kind: str
    key: str
    text: str = ""
    mutable: bool = False
    name: str = ""
    subject: str = ""
    status: str = ""
    stream_error: str = ""

def accept_user_input(self, text: str) -> None:
    self._append_block(TranscriptBlock("user", self._new_block_id(), text=text))

def apply_projected_event(self, event: Mapping[str, Any]) -> None:
    update = self.reducer.apply(event)
    if update is not None:
        self._apply_block_update(update)
~~~

Create assistant, thinking, and tool blocks with existing model request ids and tool call ids. Mark blocks immutable on model.response_committed, model.response_aborted, model.request_failed, and tool.finished. Keep styled user/tool cards, Markdown, notices, hidden stdout, and stderr behavior. Remove tail slicing from persistent UI.

- [ ] **Step 5: Build full-history frames**

~~~python
def build_frame(self, *, width: int, editor: EditorState) -> ScreenFrame:
    history = self.build_history_lines(width)
    editor_lines, cursor_row, cursor_column = editor.render_lines(width)
    rows = (*history, "─" * width, *editor_lines, "─" * width,
            *self._completion_lines(width), self._footer_line(width))
    lines = tuple(row for row in rows if row is not None)
    return ScreenFrame(lines, len(history) + 1 + cursor_row, cursor_column)
~~~

History includes every ordered block. Editor, completion, and footer are transient tail rows. Empty completion and footer rows are omitted rather than reserved.

- [ ] **Step 6: Run tests and commit**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui -v

Expected: PASS, with Markdown/tool tests changed to assert logical lines instead of prompt_toolkit fragments.

~~~bash
git add src/laohuangcode/terminal_markdown.py src/laohuangcode/terminal_ui.py \
  tests/test_terminal_ui.py
git commit -m "refactor(tui): model transcript as append-only blocks"
~~~

### Task 4: Establish the unified raw-terminal UI loop

**Files:**
- Modify: src/laohuangcode/terminal_ui.py
- Modify: src/laohuangcode/terminal_input.py
- Modify: tests/test_terminal_ui.py

**Consumes:** Renderer, editor, and block/frame interfaces from Tasks 1 through 3.

**Produces:** InteractiveTerminalLoop, strict event/input serialization, live command questions, and removal of the old persistent prompt_toolkit route.

- [ ] **Step 1: Write failing one-writer and two-turn streaming integration tests**

~~~python
def test_loop_preserves_first_turn_while_second_response_streams(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    ui = TerminalUI(theme="dark", terminal_driver=terminal)
    submitted = []

    ui.start_loop(submitted.append)
    ui.feed_input_bytes(b"first\r")
    ui.publish_event(event("model.text_delta", "r1", text="answer one"))
    ui.publish_event(event("model.response_committed", "r1"))
    ui.feed_input_bytes(b"second\r")
    ui.publish_event(event("model.text_delta", "r2", text="answer two"))
    ui.drain_loop()

    self.assertEqual(submitted, ["first", "second"])
    self.assertIn("first", terminal.all_output)
    self.assertIn("answer one", terminal.all_output)
    self.assertIn("answer two", terminal.all_output)

def test_event_publication_does_not_write_before_loop_drains(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    ui = TerminalUI(terminal_driver=terminal)
    ui.publish_event(event("ui.message", "", text="queued"))

    self.assertEqual(terminal.writes(), "")
    ui.drain_loop()
    self.assertIn("queued", terminal.writes())
~~~

- [ ] **Step 2: Run tests to prove the red state**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui.TerminalUITests.test_loop_preserves_first_turn_while_second_response_streams tests.test_terminal_ui.TerminalUITests.test_event_publication_does_not_write_before_loop_drains -v

Expected: FAIL because TerminalUI still uses an event-renderer thread and PiTerminalApplication.

- [ ] **Step 3: Implement a wakeable loop with one terminal writer**

~~~python
class InteractiveTerminalLoop:
    def __init__(self, ui: TerminalUI, driver: TerminalDriver) -> None:
        self._ui = ui
        self._driver = driver
        self._events: Queue[Any] = Queue(maxsize=4_096)
        self._decoder = RawInputDecoder()
        self._editor = EditorState()
        self._wake_read, self._wake_write = os.pipe()

    def publish_event(self, event: Any) -> None:
        self._events.put_nowait(event)
        os.write(self._wake_write, b"e")
~~~

Register stdin and the wake pipe with selectors.DefaultSelector. In run(), drain every queued event and decoded input action, then render one frame. Coalesce text deltas by draining the queue before rendering. Agent/event threads only publish into the loop; only run() calls renderer.write.

- [ ] **Step 4: Connect submit, questions, cancellation, EOF, and shutdown**

~~~python
def _apply_effect(self, effect: EditorEffect, on_submit: Callable[[str], None]) -> None:
    if effect.submit is not None:
        self._ui.accept_user_input(effect.submit)
        on_submit(effect.submit)
    if effect.cancel_requested:
        self._ui._cancel_from_keybinding()
    if effect.exit_requested:
        self._exit_requested = True
~~~

Use a modal EditorState mode for login and model-selection questions; do not nest PromptSession or getpass in a live session. In finally, close selector and wake descriptors, show cursor, restore terminal mode, and expose a captured write error to CLI.

- [ ] **Step 5: Remove only the persistent prompt_toolkit path**

Delete PiTerminalApplication, _terminal_app, _invalidate_prompt, and direct live-session Console.print branches. Keep PiInputSession, prompt_toolkit imports required by it, and PlainEventSink.

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_screen tests.test_terminal_editor tests.test_terminal_ui -v

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/laohuangcode/terminal_ui.py src/laohuangcode/terminal_input.py \
  tests/test_terminal_ui.py
git commit -m "feat(tui): run interactive terminal through one pi-style loop"
~~~

### Task 5: Integrate the new loop with CLI startup and shutdown

**Files:**
- Modify: src/laohuangcode/cli.py
- Modify: tests/test_cli.py
- Modify: tests/test_terminal_ui.py

**Consumes:** TerminalUI.run(on_submit), TerminalUI.request_exit(), and loop-error status.

**Produces:** Clean session coordinator/shutdown behavior through the new loop and unchanged pipe mode.

- [ ] **Step 1: Write failing CLI lifecycle tests**

~~~python
class FakePiLoopUI:
    def __init__(self, *, inputs: tuple[str, ...] = (), error: Exception | None = None) -> None:
        self.inputs = inputs
        self.render_error = error

    def run(self, submit: Callable[[str], None]) -> None:
        for text in self.inputs:
            submit(text)

    def close(self) -> None:
        return None

def test_persistent_repl_sends_two_inputs_then_exits_cleanly(self):
    ui = FakePiLoopUI(inputs=("first", "second", "/exit"))
    session = FakeSession()

    clean = run_session_repl(session, ui=ui)

    self.assertTrue(clean)
    self.assertEqual(session.inputs, ["first", "second", "/exit"])

def test_persistent_repl_returns_false_for_terminal_write_failure(self):
    ui = FakePiLoopUI(error=BrokenPipeError("closed"))
    session = FakeSession()

    self.assertFalse(run_session_repl(session, ui=ui))
~~~

- [ ] **Step 2: Run tests to prove the red state**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_cli -v

Expected: FAIL because the persistent REPL assumes the old renderer thread and has no loop-error contract.

- [ ] **Step 3: Simplify persistent session ownership**

~~~python
def _run_persistent_session_repl(session, *, command_handler, ui) -> bool:
    submitted: Queue[str | None] = Queue()
    coordinator = Thread(target=coordinate, daemon=True)
    coordinator.start()
    try:
        ui.show_welcome()
        ui.run(submitted.put)
    finally:
        submitted.put(None)
        submitted.join()
        clean_session = session.close(wait=True, timeout=10)
        ui.close()
    return clean_session and ui.render_error is None
~~~

Retain coordinator logic so semantic routing cannot block redraws. Preserve immediate local UI exit for /exit while still submitting its canonical slash event. Map a renderer/write failure to a nonzero main() return.

- [ ] **Step 4: Verify persistent and pipe paths separately**

Run:

~~~bash
PYTHONPATH=src .venv/bin/python -m unittest tests.test_cli -v
PYTHONPATH=src .venv/bin/python -m unittest \
  tests.test_terminal_ui.TerminalUITests.test_plain_sink_outputs_one_complete_model_response -v
~~~

Expected: PASS. Pipe mode retains PlainEventSink and never instantiates InteractiveTerminalLoop.

- [ ] **Step 5: Commit**

~~~bash
git add src/laohuangcode/cli.py tests/test_cli.py tests/test_terminal_ui.py
git commit -m "fix(cli): integrate pi regular terminal lifecycle"
~~~

### Task 6: Acceptance regressions, manual verification, and final checks

**Files:**
- Modify: README.md
- Modify: tests/test_terminal_screen.py
- Modify: tests/test_terminal_editor.py
- Modify: tests/test_terminal_ui.py
- Modify: tests/test_cli.py

**Consumes:** Completed renderer, editor, block store, loop, and CLI integration.

**Produces:** Regression coverage for every spec acceptance criterion and a real-TTY verification checklist.

- [ ] **Step 1: Write failing acceptance tests for the reported regressions**

~~~python
def test_second_response_does_not_rewrite_frozen_first_turn_bytes(self):
    terminal = MemoryTerminalDriver(columns=80, rows=24)
    ui = TerminalUI(terminal_driver=terminal)
    ui.start_loop(lambda _text: None)
    ui.feed_input_bytes(b"one\r")
    ui.publish_event(event("model.text_delta", "r1", text="first answer"))
    ui.publish_event(event("model.response_committed", "r1"))
    ui.feed_input_bytes(b"two\r")
    terminal.clear_writes()
    ui.publish_event(event("model.text_delta", "r2", text="second answer"))
    ui.drain_loop()

    self.assertNotIn("first answer", terminal.writes())
    self.assertIn("first answer", terminal.all_output)
    self.assertIn("second answer", terminal.all_output)

def test_completion_rows_equal_visible_candidates(self):
    editor = EditorState()
    editor.set_completions((CompletionItem("/exit", "退出程序", -2),))
    self.assertEqual(editor.completion_row_count, 1)
    editor.apply(InputAction(InputActionKind.INSERT, "x"), runtime_active=False)
    self.assertEqual(editor.completion_row_count, 0)

def test_ctrl_d_exits_only_for_idle_empty_editor(self):
    editor = EditorState()
    running = editor.apply(InputAction(InputActionKind.EOF), runtime_active=True)
    idle = editor.apply(InputAction(InputActionKind.EOF), runtime_active=False)
    self.assertFalse(running.exit_requested)
    self.assertTrue(idle.exit_requested)
~~~

- [ ] **Step 2: Run the focused regression suite**

Run: PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_screen tests.test_terminal_editor tests.test_terminal_ui tests.test_cli -v

Expected: PASS.

- [ ] **Step 3: Add README manual verification instructions**

~~~markdown
### Verify the interactive terminal

1. Run laoHuang in a real TTY.
2. Send a first question and wait for its answer.
3. Send a second question; scroll upward and confirm the first question and answer remain unchanged.
4. Type / then /e; verify candidates use only their visible rows, Tab accepts /exit, and editing removes the overlay.
5. During a running request press Ctrl+C. When idle, press Ctrl+D from an empty editor to exit.
~~~

- [ ] **Step 4: Run full verification**

Run:

~~~bash
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m compileall -q src
git diff --check
~~~

Expected: all tests PASS; compile and diff checks exit 0.

- [ ] **Step 5: Commit**

~~~bash
git add README.md tests/test_terminal_screen.py tests/test_terminal_editor.py \
  tests/test_terminal_ui.py tests/test_cli.py
git commit -m "test(tui): cover pi regular terminal regressions"
~~~

## Plan self-review

### Spec coverage

- Append-only history and no tail slicing: Tasks 1, 3, and 4.
- ANSI differential renderer, cursor tracking, resize, and cleanup: Task 1.
- Raw input, history, slash completion, Ctrl+C, and Ctrl+D: Tasks 2 and 4.
- One owner of presentation state and terminal writes: Task 4.
- Lifecycle keyed by model request and tool-call correlations: Task 3.
- One-shot prompt_toolkit and pipe preservation: Tasks 4 and 5.
- Shutdown, nonzero failure return, tests, and manual verification: Tasks 5 and 6.

### Type consistency

- Task 1 defines PiMainScreenRenderer.render(ScreenFrame); Tasks 3 and 4 consume it.
- Task 2 defines EditorState.apply() and EditorEffect; Task 4 consumes them.
- Task 2 defines CommandRegistry.complete(); Task 4 feeds its values to editor state.
- Task 3 defines TerminalUI.build_frame() and apply_projected_event(); Task 4 calls them.

### Scope check

This is one coherent subsystem migration: the persistent interactive terminal. Agent execution, routing, model providers, Web trace, and non-TTY output are deliberately out of scope.
