"""Raw terminal input decoding and prompt-toolkit-independent editor state."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
import os
import platform
import re
from collections.abc import Callable

from prompt_toolkit.utils import get_cwidth

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


class BufferedInputKind(StrEnum):
    SEQUENCE = "sequence"
    PASTE = "paste"


@dataclass(frozen=True, slots=True)
class InputAction:
    kind: InputActionKind
    text: str = ""


@dataclass(frozen=True, slots=True)
class BufferedInput:
    kind: BufferedInputKind
    data: bytes


@dataclass(frozen=True, slots=True)
class EditorEffect:
    submit: str | None = None
    cancel_requested: bool = False
    exit_requested: bool = False
    notice: str | None = None


_ESC = b"\x1b"
_BRACKETED_PASTE_START = b"\x1b[200~"
_BRACKETED_PASTE_END = b"\x1b[201~"
_APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE = b"\x1b[13;2u"


class StdinBuffer:
    """Buffer stdin bytes and emit complete Pi-compatible input events."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._paste_mode = False
        self._paste_buffer = bytearray()
        self._pending_kitty_printable_codepoint: int | None = None

    def feed(self, data: bytes) -> tuple[BufferedInput, ...]:
        if not data:
            return ()
        self._buffer.extend(data)
        events: list[BufferedInput] = []
        self._process_buffer(events)
        return tuple(events)

    def flush(self) -> tuple[BufferedInput, ...]:
        if self._paste_mode or not self._buffer:
            return ()
        sequence = bytes(self._buffer)
        self._buffer.clear()
        self._pending_kitty_printable_codepoint = None
        return (BufferedInput(BufferedInputKind.SEQUENCE, sequence),)

    def clear(self) -> None:
        self._buffer.clear()
        self._paste_buffer.clear()
        self._paste_mode = False
        self._pending_kitty_printable_codepoint = None

    def _process_buffer(self, events: list[BufferedInput]) -> None:
        if self._paste_mode:
            self._paste_buffer.extend(self._buffer)
            self._buffer.clear()
            self._emit_finished_paste(events)
            return

        start_index = bytes(self._buffer).find(_BRACKETED_PASTE_START)
        if start_index != -1:
            before_paste = bytes(self._buffer[:start_index])
            sequences, _remainder = _extract_complete_sequences(before_paste)
            for sequence in sequences:
                self._emit_sequence(events, sequence)
            after_start = self._buffer[
                start_index + len(_BRACKETED_PASTE_START) :
            ]
            self._buffer.clear()
            self._paste_mode = True
            self._paste_buffer.extend(after_start)
            self._pending_kitty_printable_codepoint = None
            self._emit_finished_paste(events)
            return

        sequences, remainder = _extract_complete_sequences(bytes(self._buffer))
        self._buffer[:] = remainder
        for sequence in sequences:
            self._emit_sequence(events, sequence)

    def _emit_finished_paste(self, events: list[BufferedInput]) -> None:
        end_index = bytes(self._paste_buffer).find(_BRACKETED_PASTE_END)
        if end_index == -1:
            return
        pasted = bytes(self._paste_buffer[:end_index])
        remaining = bytes(
            self._paste_buffer[end_index + len(_BRACKETED_PASTE_END) :]
        )
        self._paste_buffer.clear()
        self._paste_mode = False
        self._pending_kitty_printable_codepoint = None
        events.append(BufferedInput(BufferedInputKind.PASTE, pasted))
        if remaining:
            self._buffer.extend(remaining)
            self._process_buffer(events)

    def _emit_sequence(
        self,
        events: list[BufferedInput],
        sequence: bytes,
    ) -> None:
        raw_codepoint = _single_codepoint(sequence)
        if (
            raw_codepoint is not None
            and raw_codepoint == self._pending_kitty_printable_codepoint
        ):
            self._pending_kitty_printable_codepoint = None
            return
        self._pending_kitty_printable_codepoint = (
            _parse_unmodified_kitty_printable_codepoint(sequence)
        )
        events.append(BufferedInput(BufferedInputKind.SEQUENCE, sequence))


class TerminalInputFilter:
    """Filter terminal negotiation responses before editor decoding."""

    _KITTY_FLAGS_RE = re.compile(rb"^\x1b\[\?(\d+)u$")
    _DEVICE_ATTRIBUTES_RE = re.compile(rb"^\x1b\[\?[\d;]*c$")
    _PREFIX_RE = re.compile(rb"^\x1b\[\?[\d;]*$")

    def __init__(
        self,
        *,
        is_apple_terminal: Callable[[], bool] | None = None,
        shift_pressed: Callable[[], bool] | None = None,
        enable_modify_other_keys: Callable[[], None] | None = None,
        disable_modify_other_keys: Callable[[], None] | None = None,
    ) -> None:
        self._pending_negotiation_prefix = b""
        self._is_apple_terminal = is_apple_terminal or _is_apple_terminal_session
        self._shift_pressed = shift_pressed or (lambda: False)
        self._enable_modify_other_keys = enable_modify_other_keys or (lambda: None)
        self._disable_modify_other_keys = disable_modify_other_keys or (lambda: None)
        self.kitty_protocol_active = False

    def feed(self, sequence: bytes) -> tuple[bytes, ...]:
        if self._pending_negotiation_prefix:
            combined = self._pending_negotiation_prefix + sequence
            if self._handle_negotiation(combined):
                self._pending_negotiation_prefix = b""
                return ()
            if self._is_negotiation_prefix(combined):
                self._pending_negotiation_prefix = combined
                return ()
            pending = self._pending_negotiation_prefix
            self._pending_negotiation_prefix = b""
            return (pending, *self.feed(sequence))

        if self._handle_negotiation(sequence):
            return ()
        if self._is_negotiation_prefix(sequence):
            self._pending_negotiation_prefix = sequence
            return ()
        return (self._normalize_platform_input(sequence),)

    def flush(self) -> tuple[bytes, ...]:
        if not self._pending_negotiation_prefix:
            return ()
        pending = self._pending_negotiation_prefix
        self._pending_negotiation_prefix = b""
        return (self._normalize_platform_input(pending),)

    def clear(self) -> None:
        self._pending_negotiation_prefix = b""

    def _handle_negotiation(self, sequence: bytes) -> bool:
        flags = self._KITTY_FLAGS_RE.match(sequence)
        if flags is not None:
            value = int(flags.group(1))
            if value:
                self._disable_modify_other_keys()
                self.kitty_protocol_active = True
            else:
                self._enable_modify_other_keys()
            return True
        if self._DEVICE_ATTRIBUTES_RE.match(sequence) is not None:
            if not self.kitty_protocol_active:
                self._enable_modify_other_keys()
            return True
        return False

    def _is_negotiation_prefix(self, sequence: bytes) -> bool:
        return sequence == b"\x1b[" or self._PREFIX_RE.match(sequence) is not None

    def _normalize_platform_input(self, sequence: bytes) -> bytes:
        if (
            sequence == b"\r"
            and self._is_apple_terminal()
            and self._shift_pressed()
        ):
            return _APPLE_TERMINAL_SHIFT_ENTER_SEQUENCE
        return sequence


class RawInputDecoder:
    """Incrementally convert raw bytes into editor actions."""

    _ESCAPE_ACTIONS = {
        b"\x1b[A": InputActionKind.HISTORY_UP,
        b"\x1b[B": InputActionKind.HISTORY_DOWN,
        b"\x1b[C": InputActionKind.CURSOR_RIGHT,
        b"\x1b[D": InputActionKind.CURSOR_LEFT,
        b"\x1bOA": InputActionKind.HISTORY_UP,
        b"\x1bOB": InputActionKind.HISTORY_DOWN,
        b"\x1bOC": InputActionKind.CURSOR_RIGHT,
        b"\x1bOD": InputActionKind.CURSOR_LEFT,
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
            if _is_kitty_release(sequence):
                del self._buffer[: final + 1]
                return False
            special = _decode_special_escape_action(sequence)
            if special is not None:
                del self._buffer[: final + 1]
                return special
            printable = _decode_printable_key(sequence)
            if printable is not None:
                del self._buffer[: final + 1]
                return InputAction(InputActionKind.INSERT, printable)
            kind = self._ESCAPE_ACTIONS.get(sequence)
            del self._buffer[: final + 1]
            return InputAction(kind) if kind is not None else False
        if self._buffer[1] == ord("O") and len(self._buffer) >= 3:
            sequence = bytes(self._buffer[:3])
            kind = self._ESCAPE_ACTIONS.get(sequence)
            del self._buffer[:3]
            return InputAction(kind) if kind is not None else False
        # An unsupported Alt sequence has no editor meaning; retain its character.
        del self._buffer[0]
        return False


def _extract_complete_sequences(buffer: bytes) -> tuple[tuple[bytes, ...], bytes]:
    sequences: list[bytes] = []
    position = 0
    while position < len(buffer):
        remaining = buffer[position:]
        if remaining.startswith(_ESC):
            sequence_end = 1
            while sequence_end <= len(remaining):
                candidate = remaining[:sequence_end]
                status = _complete_sequence_status(candidate)
                if status == "complete":
                    if candidate == b"\x1b\x1b":
                        next_byte = remaining[sequence_end : sequence_end + 1]
                        if next_byte in {b"[", b"]", b"O", b"P", b"_"}:
                            sequences.append(_ESC)
                            position += 1
                            break
                    sequences.append(candidate)
                    position += sequence_end
                    break
                if status == "incomplete":
                    sequence_end += 1
                    continue
                sequences.append(candidate)
                position += sequence_end
                break
            if sequence_end > len(remaining):
                return tuple(sequences), remaining
            continue

        next_escape = remaining.find(_ESC)
        if next_escape == -1:
            sequences.append(remaining)
            position = len(buffer)
        elif next_escape == 0:
            continue
        else:
            sequences.append(remaining[:next_escape])
            position += next_escape
    return tuple(sequences), b""


def _complete_sequence_status(data: bytes) -> str:
    if not data.startswith(_ESC):
        return "not-escape"
    if len(data) == 1:
        return "incomplete"
    after_escape = data[1:]
    if after_escape.startswith(b"[M"):
        return "complete" if len(data) >= 6 else "incomplete"
    if after_escape.startswith(b"["):
        return _complete_csi_status(data)
    if after_escape.startswith(b"]"):
        return "complete" if (data.endswith(b"\x1b\\") or data.endswith(b"\x07")) else "incomplete"
    if after_escape.startswith(b"P") or after_escape.startswith(b"_"):
        return "complete" if data.endswith(b"\x1b\\") else "incomplete"
    if after_escape.startswith(b"O"):
        return "complete" if len(after_escape) >= 2 else "incomplete"
    if len(after_escape) == 1:
        return "complete"
    return "complete"


def _complete_csi_status(data: bytes) -> str:
    if not data.startswith(b"\x1b["):
        return "complete"
    if len(data) < 3:
        return "incomplete"
    payload = data[2:]
    final_byte = payload[-1]
    if not 0x40 <= final_byte <= 0x7E:
        return "incomplete"
    if payload.startswith(b"<"):
        if re.match(rb"^<\d+;\d+;\d+[Mm]$", payload):
            return "complete"
        if final_byte in (ord("M"), ord("m")):
            parts = payload[1:-1].split(b";")
            if len(parts) == 3 and all(part.isdigit() for part in parts):
                return "complete"
        return "incomplete"
    return "complete"


def _single_codepoint(sequence: bytes) -> int | None:
    try:
        text = sequence.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if len(text) != 1:
        return None
    return ord(text)


def _parse_unmodified_kitty_printable_codepoint(sequence: bytes) -> int | None:
    match = re.match(rb"^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$", sequence)
    if match is None:
        return None
    codepoint = int(match.group(1))
    return codepoint if codepoint >= 32 else None


def _is_apple_terminal_session() -> bool:
    return (
        platform.system() == "Darwin"
        and os.environ.get("TERM_PROGRAM") == "Apple_Terminal"
    )


def _is_kitty_release(sequence: bytes) -> bool:
    if _BRACKETED_PASTE_START in sequence:
        return False
    return any(
        marker in sequence
        for marker in (
            b":3u",
            b":3~",
            b":3A",
            b":3B",
            b":3C",
            b":3D",
            b":3H",
            b":3F",
        )
    )


def _decode_special_escape_action(sequence: bytes) -> InputAction | None:
    if sequence in {b"\x1b[13;2u", b"\x1b[57414;2u"}:
        return InputAction(InputActionKind.NEWLINE)
    if sequence in {b"\x1b[13u", b"\x1b[13;1u", b"\x1b[57414u", b"\x1b[57414;1u"}:
        return InputAction(InputActionKind.SUBMIT)
    if sequence in {b"\x1b[9u", b"\x1b[9;1u"}:
        return InputAction(InputActionKind.COMPLETE)
    if sequence in {b"\x1b[127u", b"\x1b[127;1u"}:
        return InputAction(InputActionKind.BACKSPACE)
    if sequence in {b"\x1b[27u", b"\x1b[27;1u"}:
        return InputAction(InputActionKind.DISMISS)
    return None


def _decode_printable_key(sequence: bytes) -> str | None:
    kitty = _decode_kitty_printable(sequence)
    if kitty is not None:
        return kitty
    return _decode_modify_other_keys_printable(sequence)


def _decode_kitty_printable(sequence: bytes) -> str | None:
    match = re.match(
        rb"^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$",
        sequence,
    )
    if match is None:
        return None
    codepoint = int(match.group(1))
    shifted = match.group(2)
    shifted_codepoint = int(shifted) if shifted else None
    modifier = int(match.group(4) or b"1") - 1
    lock_mask = 64 + 128
    if modifier & ~(1 | lock_mask):
        return None
    if modifier & (2 | 4):
        return None
    effective = shifted_codepoint if (modifier & 1 and shifted_codepoint) else codepoint
    if effective < 32:
        return None
    try:
        return chr(effective)
    except ValueError:
        return None


def _decode_modify_other_keys_printable(sequence: bytes) -> str | None:
    match = re.match(rb"^\x1b\[27;(\d+);(\d+)~$", sequence)
    if match is None:
        return None
    modifier = int(match.group(1)) - 1
    if modifier & ~1:
        return None
    codepoint = int(match.group(2))
    if codepoint < 32:
        return None
    try:
        return chr(codepoint)
    except ValueError:
        return None


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

    def render_lines(
        self,
        width: int,
        *,
        prompt: str = "❯ ",
        mask: bool = False,
    ) -> tuple[tuple[str, ...], int, int]:
        width = max(3, width)
        prompt_width = max(1, get_cwidth(prompt))
        content_width = max(1, width - prompt_width)
        display_text = "*" * len(self.text) if mask else self.text
        source_lines = display_text.split("\n")
        rows: list[str] = []
        for source in source_lines:
            rows.extend(self._wrap(source, content_width))
        if (
            display_text
            and not display_text.endswith("\n")
            and self._display_width(source_lines[-1]) % content_width == 0
        ):
            rows.append("")
        rendered = tuple(
            (prompt if index == 0 else " " * prompt_width) + row
            for index, row in enumerate(rows)
        )
        before = display_text[: self.cursor]
        before_lines = before.split("\n")
        prior_rows = sum(
            len(self._wrap(line, content_width))
            for line in before_lines[:-1]
        )
        current = before_lines[-1]
        current_row, current_column = self._cursor_position(current, content_width)
        cursor_row = prior_rows + current_row
        cursor_column = prompt_width + current_column
        return rendered, min(cursor_row, len(rendered) - 1), min(cursor_column, width - 1)

    @staticmethod
    def _wrap(text: str, width: int) -> list[str]:
        rows: list[str] = []
        row = ""
        row_width = 0
        for char in text:
            char_width = max(1, get_cwidth(char))
            if row and row_width + char_width > width:
                rows.append(row)
                row = ""
                row_width = 0
            row += char
            row_width += char_width
        if row or not rows:
            rows.append(row)
        return rows

    @staticmethod
    def _display_width(text: str) -> int:
        return sum(max(1, get_cwidth(char)) for char in text)

    @classmethod
    def _cursor_position(cls, text: str, width: int) -> tuple[int, int]:
        row = 0
        column = 0
        for char in text:
            char_width = max(1, get_cwidth(char))
            if column and column + char_width > width:
                row += 1
                column = 0
            column += char_width
            if column == width:
                row += 1
                column = 0
        return row, column

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
            self._clear_completions()
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
        self._clear_completions()
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
