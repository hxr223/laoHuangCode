"""Incremental renderer for Pi's regular terminal screen."""

from __future__ import annotations

from dataclasses import dataclass
import os
import re
from typing import Protocol

from prompt_toolkit.utils import get_cwidth


@dataclass(frozen=True, slots=True)
class TerminalSize:
    columns: int
    rows: int


@dataclass(frozen=True, slots=True)
class ScreenFrame:
    lines: tuple[str, ...]
    active_start: int
    cursor_row: int
    cursor_col: int = 0


class TerminalDriver(Protocol):
    def write(self, data: str) -> None: ...

    def flush(self) -> None: ...

    def get_size(self) -> TerminalSize: ...

    def restore(self) -> None: ...


class MemoryTerminalDriver:
    """In-memory terminal driver for renderer tests."""

    def __init__(self, *, columns: int, rows: int) -> None:
        self._size = TerminalSize(columns, rows)
        self._writes: list[str] = []
        self.flushes = 0
        self.restored = False
        self.restore_calls = 0

    def write(self, data: str) -> None:
        self._writes.append(data)

    def flush(self) -> None:
        self.flushes += 1

    def get_size(self) -> TerminalSize:
        return self._size

    def resize(self, *, columns: int, rows: int) -> None:
        self._size = TerminalSize(columns, rows)

    def restore(self) -> None:
        self.restored = True
        self.restore_calls += 1

    def writes(self) -> str:
        return "".join(self._writes)

    def write_chunks(self) -> tuple[str, ...]:
        return tuple(self._writes)

    def clear_writes(self) -> None:
        self._writes.clear()


class PiMainScreenRenderer:
    """Pi regular-terminal differential renderer."""

    def __init__(self, terminal: TerminalDriver) -> None:
        self._terminal = terminal
        self._previous_lines: tuple[str, ...] = ()
        self._previous_width = 0
        self._previous_height = 0
        self._previous_viewport_top = 0
        self._cursor_row = 0
        self._hardware_cursor_row = 0
        self._max_lines_rendered = 0
        self._clear_on_shrink = os.environ.get("PI_CLEAR_ON_SHRINK") == "1"
        self._closed = False

    def render(self, frame: ScreenFrame) -> None:
        if self._closed:
            return

        size = self._terminal.get_size()
        width = max(1, size.columns)
        height = max(1, size.rows)
        new_lines = frame.lines
        self._validate_lines(new_lines, width)

        width_changed = self._previous_width != 0 and self._previous_width != width
        height_changed = self._previous_height != 0 and self._previous_height != height
        previous_buffer_length = (
            self._previous_viewport_top + self._previous_height
            if self._previous_height > 0
            else height
        )
        prev_viewport_top = (
            max(0, previous_buffer_length - height)
            if height_changed
            else self._previous_viewport_top
        )
        viewport_top = prev_viewport_top
        hardware_cursor_row = self._hardware_cursor_row

        def compute_line_diff(target_row: int) -> int:
            current_screen_row = hardware_cursor_row - prev_viewport_top
            target_screen_row = target_row - viewport_top
            return target_screen_row - current_screen_row

        def full_render(clear: bool) -> None:
            buffer = "\x1b[?2026h"
            if clear:
                buffer += "\x1b[2J\x1b[H\x1b[3J"
            for index, line in enumerate(new_lines):
                if index:
                    buffer += "\r\n"
                buffer += line
            buffer += "\x1b[?2026l"
            self._cursor_row = max(0, len(new_lines) - 1)
            self._hardware_cursor_row = self._cursor_row
            if clear:
                self._max_lines_rendered = len(new_lines)
            else:
                self._max_lines_rendered = max(
                    self._max_lines_rendered,
                    len(new_lines),
                )
            buffer_length = max(height, len(new_lines))
            self._previous_viewport_top = max(0, buffer_length - height)
            buffer += self._position_hardware_cursor(frame, width, len(new_lines))
            self._commit_state(new_lines, width, height)
            self._terminal.write(buffer)
            self._terminal.flush()

        if not self._previous_lines and not width_changed and not height_changed:
            full_render(False)
            return
        if width_changed or height_changed:
            full_render(True)
            return
        if (
            self._clear_on_shrink
            and len(new_lines) < self._max_lines_rendered
        ):
            full_render(True)
            return

        span = self._changed_span(self._previous_lines, new_lines)
        if span is None:
            buffer = self._position_hardware_cursor(frame, width, len(new_lines))
            self._previous_viewport_top = prev_viewport_top
            self._previous_height = height
            if buffer:
                self._terminal.write(buffer)
            self._terminal.flush()
            return

        first_changed, last_changed = span
        appended_lines = len(new_lines) > len(self._previous_lines)
        if appended_lines and first_changed == -1:
            first_changed = len(self._previous_lines)
            last_changed = len(new_lines) - 1
        append_start = (
            appended_lines
            and first_changed == len(self._previous_lines)
            and first_changed > 0
        )

        if first_changed >= len(new_lines):
            buffer = "\x1b[?2026h"
            target_row = max(0, len(new_lines) - 1)
            if target_row < prev_viewport_top:
                full_render(True)
                return
            line_diff = compute_line_diff(target_row)
            if line_diff > 0:
                buffer += f"\x1b[{line_diff}B"
            elif line_diff < 0:
                buffer += f"\x1b[{-line_diff}A"
            buffer += "\r"
            extra_lines = len(self._previous_lines) - len(new_lines)
            if extra_lines > height:
                full_render(True)
                return
            clear_start_offset = 0 if len(new_lines) == 0 else 1
            if extra_lines > 0 and clear_start_offset > 0:
                buffer += f"\x1b[{clear_start_offset}B"
            for index in range(extra_lines):
                buffer += "\r\x1b[2K"
                if index < extra_lines - 1:
                    buffer += "\x1b[1B"
            move_back = max(0, extra_lines - 1 + clear_start_offset)
            if move_back > 0:
                buffer += f"\x1b[{move_back}A"
            buffer += "\x1b[?2026l"
            self._cursor_row = target_row
            self._hardware_cursor_row = target_row
            buffer += self._position_hardware_cursor(frame, width, len(new_lines))
            self._previous_viewport_top = prev_viewport_top
            self._commit_state(new_lines, width, height)
            self._terminal.write(buffer)
            self._terminal.flush()
            return

        if first_changed < prev_viewport_top:
            full_render(True)
            return

        buffer = "\x1b[?2026h"
        prev_viewport_bottom = prev_viewport_top + height - 1
        move_target_row = first_changed - 1 if append_start else first_changed
        if move_target_row > prev_viewport_bottom:
            current_screen_row = max(
                0,
                min(height - 1, hardware_cursor_row - prev_viewport_top),
            )
            move_to_bottom = height - 1 - current_screen_row
            if move_to_bottom > 0:
                buffer += f"\x1b[{move_to_bottom}B"
            scroll = move_target_row - prev_viewport_bottom
            buffer += "\r\n" * scroll
            prev_viewport_top += scroll
            viewport_top += scroll
            hardware_cursor_row = move_target_row

        line_diff = compute_line_diff(move_target_row)
        if line_diff > 0:
            buffer += f"\x1b[{line_diff}B"
        elif line_diff < 0:
            buffer += f"\x1b[{-line_diff}A"
        buffer += "\r\n" if append_start else "\r"

        render_end = min(last_changed, len(new_lines) - 1)
        for index in range(first_changed, render_end + 1):
            if index > first_changed:
                buffer += "\r\n"
            buffer += "\x1b[2K"
            buffer += new_lines[index]

        final_cursor_row = render_end
        if len(self._previous_lines) > len(new_lines):
            if render_end < len(new_lines) - 1:
                move_down = len(new_lines) - 1 - render_end
                buffer += f"\x1b[{move_down}B"
                final_cursor_row = len(new_lines) - 1
            extra_lines = len(self._previous_lines) - len(new_lines)
            for _index in range(len(new_lines), len(self._previous_lines)):
                buffer += "\r\n\x1b[2K"
            buffer += f"\x1b[{extra_lines}A"

        buffer += "\x1b[?2026l"
        self._cursor_row = max(0, len(new_lines) - 1)
        self._hardware_cursor_row = final_cursor_row
        self._max_lines_rendered = max(self._max_lines_rendered, len(new_lines))
        self._previous_viewport_top = max(prev_viewport_top, final_cursor_row - height + 1)
        buffer += self._position_hardware_cursor(frame, width, len(new_lines))
        self._commit_state(new_lines, width, height)
        self._terminal.write(buffer)
        self._terminal.flush()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._terminal.write("\x1b[?25h")
            self._terminal.flush()
        finally:
            self._terminal.restore()

    @staticmethod
    def _changed_span(
        previous: tuple[str, ...], current: tuple[str, ...]
    ) -> tuple[int, int] | None:
        first = -1
        last = -1
        for index in range(max(len(previous), len(current))):
            old = previous[index] if index < len(previous) else ""
            new = current[index] if index < len(current) else ""
            if old == new:
                continue
            if first == -1:
                first = index
            last = index
        if first == -1:
            return None
        return first, last

    def _position_hardware_cursor(
        self,
        frame: ScreenFrame,
        width: int,
        total_lines: int,
    ) -> str:
        if not frame.lines or total_lines <= 0:
            return ""
        target_row = max(0, min(frame.cursor_row, total_lines - 1))
        target_col = max(0, min(frame.cursor_col, max(width - 1, 0)))
        row_delta = target_row - self._hardware_cursor_row
        buffer = ""
        if row_delta > 0:
            buffer += f"\x1b[{row_delta}B"
        elif row_delta < 0:
            buffer += f"\x1b[{-row_delta}A"
        buffer += f"\x1b[{target_col + 1}G"
        self._hardware_cursor_row = target_row
        return buffer

    def _commit_state(
        self,
        lines: tuple[str, ...],
        width: int,
        height: int,
    ) -> None:
        self._previous_lines = lines
        self._previous_width = width
        self._previous_height = height

    @staticmethod
    def _validate_lines(lines: tuple[str, ...], width: int) -> None:
        for index, line in enumerate(lines):
            visible_width = _visible_width(line)
            if visible_width > width:
                raise ValueError(
                    f"rendered line {index} exceeds terminal width "
                    f"({visible_width} > {width})"
                )


_ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"
    r"|\x1b\][^\x07]*(?:\x07|\x1b\\)"
    r"|\x1b[P_].*?\x1b\\",
    re.DOTALL,
)


def _visible_width(text: str) -> int:
    if not text:
        return 0
    stripped = _ANSI_RE.sub("", text).replace("\t", "   ")
    return sum(max(0, get_cwidth(char)) for char in stripped)
