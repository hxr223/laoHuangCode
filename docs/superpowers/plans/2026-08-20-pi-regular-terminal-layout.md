# Pi Regular Terminal Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the interactive terminal consume only the rows occupied by its transcript, editor, completion candidates, and footer, matching Pi regular-mode behavior.

**Architecture:** Keep the established single terminal owner and prompt_toolkit input loop, but replace its viewport-filling layout contract with a content-sized regular layout. Every vertical child receives an exact dynamic height derived from the current rendered content; the transcript is clipped to the rows left after the live editor, completion menu, borders, and footer, so no child can consume spare terminal rows.

**Tech Stack:** Python 3.11+, prompt-toolkit 3, unittest, Vt100_Output test terminal.

**Spec:** `docs/superpowers/specs/2026-08-18-minimal-coding-agent-design.md`

## Global Constraints

- Production interactive output remains owned exclusively by `TerminalUI` / its terminal application; no Rich or background thread may write terminal bytes.
- Standard TTY mode remains `full_screen=False`; no alternate-screen escape sequence is emitted.
- `/` completions retain Tab/Enter selection behavior and show no more rows than visible candidates (maximum six).
- `Ctrl+C`, `Ctrl+D`, `/exit`, command questions, history, multiline input, and the plain non-TTY sink remain compatible.
- Tests use Python `unittest` and must not contact a model provider.

---

### Task 1: Lock the regular-layout contract with a live completion test

**Files:**
- Modify: `tests/test_terminal_ui.py`

**Interfaces:**
- Consumes: `PiTerminalApplication.run(on_submit)`, `CommandCompleter`, `create_pipe_input`, and `WritePosition`.
- Produces: a regression test proving a 60-row terminal with two transcript rows and one `/exit` candidate allocates only those occupied rows.

- [ ] **Step 1: Write the failing test**

```python
def test_persistent_terminal_uses_only_content_rows_for_a_completion(self):
    # Start the real terminal app with a two-line transcript and type "/e".
    # Inspect the live root container at 60 rows.
    self.assertEqual(
        root._divide_heights(WritePosition(0, 0, 80, 60)),
        [2, 0, 1, 0, 1, 0, 1, 0, 1],
    )
```

The expected positive row heights are: transcript 2, top border 1, one-line editor 1, bottom border 1, and one completion candidate 1. Prompt-toolkit's inserted padding children are represented by the zero entries.

- [ ] **Step 2: Run the test to verify it fails**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui.TerminalUITests.test_persistent_terminal_uses_only_content_rows_for_a_completion -v`

Expected: FAIL because the current layout allocates remaining rows to the transcript plus 10 editor rows and 6 menu rows.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/test_terminal_ui.py
git commit -m "test(tui): expose regular layout row allocation"
```

### Task 2: Replace flex heights with content-sized regular layout heights

**Files:**
- Modify: `src/laohuangcode/terminal_input.py`
- Test: `tests/test_terminal_ui.py`

**Interfaces:**
- Consumes: `transcript(width, height) -> AnyFormattedText`, `Buffer.default_buffer`, `CompletionsMenu`, and `footer() -> AnyFormattedText`.
- Produces: `PiTerminalApplication` dynamic height callables for transcript, editor, completion menu, and footer.

- [ ] **Step 1: Add exact-height helpers**

```python
def _transcript_height(self) -> Dimension: ...
def _editor_height(self) -> Dimension: ...
def _completion_height(self) -> Dimension: ...
def _footer_height(self) -> Dimension: ...
```

`_transcript_height` counts displayed newline-delimited transcript rows and clips to rows left after the active editor, borders, footer, and completion candidates. `_editor_height` counts wrapped buffer rows with a minimum of one and maximum of ten. `_completion_height` returns zero when completion is hidden, otherwise `min(candidate_count, reserve_space_for_menu)`. `_footer_height` returns zero for no footer content and the visible footer row count otherwise.

- [ ] **Step 2: Use helpers in the live layout**

```python
transcript_window = Window(..., height=self._transcript_height)
editor = Window(..., height=self._editor_height)
menu = CompletionsMenu(max_height=self.reserve_space_for_menu)
menu.content.height = self._completion_height
footer = Window(..., height=self._footer_height)
```

Do not use `Dimension(weight=1)` or a min/max range for these production-session children. Their dimensions must be exact at each render, so `HSplit` has no spare capacity it can assign to blank cells.

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui.TerminalUITests.test_persistent_terminal_uses_only_content_rows_for_a_completion -v`

Expected: PASS with the literal allocation `[2, 0, 1, 0, 1, 0, 1, 0, 1]`.

- [ ] **Step 4: Add a multiline editor regression test**

```python
def test_persistent_terminal_grows_only_for_actual_multiline_input(self):
    # A two-line buffer receives exactly two editor rows, not the 10-row maximum.
```

The live container allocation must contain an editor height of 2 after an Alt+Enter line break, while the hidden completion menu remains zero rows.

- [ ] **Step 5: Run focused terminal tests**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui -v`

Expected: PASS.

- [ ] **Step 6: Commit the layout implementation and tests**

```bash
git add src/laohuangcode/terminal_input.py tests/test_terminal_ui.py
git commit -m "fix(tui): size regular layout to visible content"
```

### Task 3: Verify the single-renderer session remains end-to-end compatible

**Files:**
- Test: `tests/test_cli.py`
- Test: `tests/test_terminal_ui.py`

**Interfaces:**
- Consumes: `TerminalUI.run`, `_run_persistent_session_repl`, `AgentSession`, `PiTerminalApplication.exit`.
- Produces: regression evidence that compact layout does not alter queueing or shutdown semantics.

- [ ] **Step 1: Run the existing persistent-session exit test**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_cli.ReplTests.test_persistent_terminal_repl_exits_without_leaving_its_queue_blocked -v`

Expected: PASS and exactly one UI exit request.

- [ ] **Step 2: Run the existing Markdown and stream-boundary tests**

Run: `PYTHONPATH=src .venv/bin/python -m unittest tests.test_terminal_ui.TerminalUITests.test_single_renderer_renders_assistant_markdown tests.test_terminal_ui.TerminalUITests.test_single_renderer_keeps_stream_text_across_tool_boundaries -v`

Expected: PASS; Markdown markers remain hidden and transcript text remains intact across tool cards.

- [ ] **Step 3: Run the full offline suite and syntax checks**

Run: `PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -q && .venv/bin/python -m compileall -q src && git diff --check`

Expected: all tests pass, compilation succeeds, and `git diff --check` produces no output.

- [ ] **Step 4: Commit verification-compatible changes**

```bash
git add tests/test_cli.py tests/test_terminal_ui.py
git commit -m "test(tui): cover compact regular session behavior"
```
