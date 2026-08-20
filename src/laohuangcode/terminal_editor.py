"""Raw terminal input decoding and prompt-toolkit-independent editor state."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from .commands import CompletionItem


class InputActionKind(StrEnum):
    INSERT = "insert"
    SUBMIT = "submit"
    NEWLINE = "newline"
    COMPLETE = "complete"
    HISTORY_UP = "history_up"
    HISTORY_DOWN = "history_down"
    CURSOR_LEFT = "cursor_left"
    CURSOR_RIGHT = "cursor_right"
    BACKSPACE = "backspace"
    DISMISS = "dismiss"
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


class RawInputDecoder:
    """Incrementally convert raw bytes into editor actions."""

    _ESCAPE_ACTIONS = {
        b"\x1b[A": InputActionKind.HISTORY_UP,
        b"\x1b[B": InputActionKind.HISTORY_DOWN,
        b"\x1b[C": InputActionKind.CURSOR_RIGHT,
        b"\x1b[D": InputActionKind.CURSOR_LEFT,
    }
    _CONTROL_ACTIONS = {
        3: InputActionKind.CANCEL,
        4: InputActionKind.EOF,
        9: InputActionKind.COMPLETE,
        8: InputActionKind.BACKSPACE,
        127: InputActionKind.BACKSPACE,
    }

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> tuple[InputAction, ...]:
        self._buffer.extend(data)
        actions: list[InputAction] = []
        while self._buffer:
            if self._buffer[0] == 27:
                action = self._consume_escape()
                if action is None:
                    break
                if action:
                    actions.append(action)
                continue
            byte = self._buffer[0]
            if byte in (10, 13):
                del self._buffer[0]
                actions.append(InputAction(InputActionKind.SUBMIT))
                continue
            kind = self._CONTROL_ACTIONS.get(byte)
            if kind is not None:
                del self._buffer[0]
                actions.append(InputAction(kind))
                continue
            if byte < 32:
                # Ignore every remaining C0 control rather than leaving a
                # zero-length printable chunk at the front of the buffer.
                del self._buffer[0]
                continue
            end = 0
            while end < len(self._buffer) and self._buffer[end] >= 32 and self._buffer[end] != 127:
                end += 1
            chunk = bytes(self._buffer[:end])
            try:
                text = chunk.decode("utf-8")
            except UnicodeDecodeError as error:
                if error.reason == "unexpected end of data":
                    break
                del self._buffer[: max(1, error.start + 1)]
                continue
            del self._buffer[:end]
            if text:
                actions.append(InputAction(InputActionKind.INSERT, text))
        return tuple(actions)

    def flush(self) -> tuple[InputAction, ...]:
        """Resolve bytes which remain after the raw-input escape timeout.

        The event loop calls this after a short no-input interval.  This keeps
        split CSI sequences buffered, while a genuine standalone Escape can
        dismiss a completion overlay.
        """
        if self._buffer == b"\x1b":
            self._buffer.clear()
            return (InputAction(InputActionKind.DISMISS),)
        if self._buffer.startswith(b"\x1b["):
            self._buffer.clear()
        return self.feed(b"")

    def _consume_escape(self) -> InputAction | None | bool:
        if len(self._buffer) == 1:
            return None
        if self._buffer[1] in (10, 13):
            del self._buffer[:2]
            return InputAction(InputActionKind.NEWLINE)
        if self._buffer[1] == ord("["):
            final = next(
                (
                    index
                    for index, byte in enumerate(self._buffer[2:], start=2)
                    if 0x40 <= byte <= 0x7E
                ),
                None,
            )
            if final is None:
                return None
            sequence = bytes(self._buffer[: final + 1])
            kind = self._ESCAPE_ACTIONS.get(sequence)
            del self._buffer[: final + 1]
            return InputAction(kind) if kind is not None else False
        # An unsupported Alt sequence has no editor meaning; retain its character.
        del self._buffer[0]
        return False


class EditorState:
    """Text, history, and command-completion state for the active editor."""

    def __init__(self) -> None:
        self.text = ""
        self.cursor = 0
        self.history: tuple[str, ...] = ()
        self.history_index: int | None = None
        self._history_draft = ""
        self.completions: tuple[CompletionItem, ...] = ()
        self.selected_completion: int | None = None

    @property
    def completion_visible(self) -> bool:
        return bool(self.completions)

    def set_completions(self, values: tuple[CompletionItem, ...]) -> None:
        self.completions = values if self.text.startswith("/") else ()
        self.selected_completion = 0 if self.completions else None

    def apply(self, action: InputAction, *, runtime_active: bool) -> EditorEffect:
        if action.kind is InputActionKind.SUBMIT:
            if self.completion_visible:
                self._accept_completion()
                return EditorEffect()
            return self._submit()
        if action.kind is InputActionKind.NEWLINE:
            self._insert("\n")
            return EditorEffect()
        if action.kind is InputActionKind.CANCEL:
            return self._cancel_or_clear(runtime_active)
        if action.kind is InputActionKind.EOF:
            return self._exit_or_notice(runtime_active)
        if action.kind is InputActionKind.DISMISS:
            self._clear_completions()
            return EditorEffect()
        return self._apply_edit_action(action)

    def render_lines(self, width: int) -> tuple[tuple[str, ...], int, int]:
        width = max(3, width)
        content_width = width - 2
        source_lines = self.text.split("\n")
        rows: list[str] = []
        for source in source_lines:
            rows.extend(self._wrap(source, content_width))
        if self.text and not self.text.endswith("\n") and len(source_lines[-1]) % content_width == 0:
            rows.append("")
        rendered = tuple(
            ("❯ " if index == 0 else "  ") + row
            for index, row in enumerate(rows)
        )
        before = self.text[: self.cursor]
        prior, current = before.rsplit("\n", 1) if "\n" in before else ("", before)
        prior_rows = 0 if not prior else sum(len(self._wrap(line, content_width)) for line in prior.split("\n"))
        if "\n" in before:
            prior_rows += 1
        cursor_row = prior_rows + len(current) // content_width
        cursor_column = 2 + len(current) % content_width
        return rendered, min(cursor_row, len(rendered) - 1), min(cursor_column, width - 1)

    @staticmethod
    def _wrap(text: str, width: int) -> list[str]:
        return [text[index : index + width] for index in range(0, len(text), width)] or [""]

    def _submit(self) -> EditorEffect:
        submitted = self.text
        self._clear_completions()
        self.text = ""
        self.cursor = 0
        self.history_index = None
        self._history_draft = ""
        if not submitted:
            return EditorEffect()
        self.history = (*self.history, submitted)
        return EditorEffect(submit=submitted)

    def _cancel_or_clear(self, runtime_active: bool) -> EditorEffect:
        if runtime_active:
            return EditorEffect(cancel_requested=True)
        self.text = ""
        self.cursor = 0
        self.history_index = None
        self._clear_completions()
        return EditorEffect()

    def _exit_or_notice(self, runtime_active: bool) -> EditorEffect:
        if runtime_active:
            return EditorEffect(notice="A task is still running. Press Ctrl+C to cancel it.")
        if self.text:
            return EditorEffect(notice="Clear the editor before exiting.")
        return EditorEffect(exit_requested=True)

    def _apply_edit_action(self, action: InputAction) -> EditorEffect:
        if action.kind is InputActionKind.HISTORY_UP and self.completion_visible:
            self._move_completion(-1)
        elif action.kind is InputActionKind.HISTORY_DOWN and self.completion_visible:
            self._move_completion(1)
        elif action.kind is InputActionKind.INSERT:
            self._insert(action.text)
        elif action.kind is InputActionKind.BACKSPACE and self.cursor:
            self.text = self.text[: self.cursor - 1] + self.text[self.cursor :]
            self.cursor -= 1
        elif action.kind is InputActionKind.CURSOR_LEFT:
            self._clear_completions()
            self.cursor = max(0, self.cursor - 1)
        elif action.kind is InputActionKind.CURSOR_RIGHT:
            self._clear_completions()
            self.cursor = min(len(self.text), self.cursor + 1)
        elif action.kind is InputActionKind.HISTORY_UP:
            self._history_up()
        elif action.kind is InputActionKind.HISTORY_DOWN:
            self._history_down()
        elif action.kind is InputActionKind.COMPLETE:
            self._accept_completion()
        self._close_completion_if_context_lost()
        return EditorEffect()

    def _insert(self, text: str) -> None:
        self.text = self.text[: self.cursor] + text + self.text[self.cursor :]
        self.cursor += len(text)
        self.history_index = None

    def _accept_completion(self) -> None:
        if self.selected_completion is None:
            return
        item = self.completions[self.selected_completion]
        start = max(0, self.cursor + item.start)
        self.text = self.text[:start] + item.value + self.text[self.cursor :]
        self.cursor = start + len(item.value)
        self._clear_completions()

    def _move_completion(self, offset: int) -> None:
        if self.selected_completion is None:
            return
        self.selected_completion = (
            self.selected_completion + offset
        ) % len(self.completions)

    def _history_up(self) -> None:
        if not self.history:
            return
        if self.history_index is None:
            self._history_draft = self.text
            self.history_index = len(self.history) - 1
        else:
            self.history_index = max(0, self.history_index - 1)
        self.text = self.history[self.history_index]
        self.cursor = len(self.text)

    def _history_down(self) -> None:
        if self.history_index is None:
            return
        if self.history_index == len(self.history) - 1:
            self.text = self._history_draft
            self.history_index = None
        else:
            self.history_index += 1
            self.text = self.history[self.history_index]
        self.cursor = len(self.text)

    def _close_completion_if_context_lost(self) -> None:
        if not self.text.startswith("/"):
            self._clear_completions()

    def _clear_completions(self) -> None:
        self.completions = ()
        self.selected_completion = None
