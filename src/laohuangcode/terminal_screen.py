"""Incremental renderer for Pi's regular terminal screen."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


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
    """Append completed terminal history and redraw only the active tail."""

    def __init__(self, terminal: TerminalDriver) -> None:
        self._terminal = terminal
        self._previous_lines: tuple[str, ...] = ()
        self._previous_active_start = 0
        self._previous_size: TerminalSize | None = None
        self._hardware_row = 0
        self._max_rows = 0
        self._closed = False
        self._pending: list[str] | None = None

    def render(self, frame: ScreenFrame) -> None:
        if self._closed:
            return

        self._pending = []
        try:
            size = self._terminal.get_size()
            first = self._first_changed(self._previous_lines, frame.lines)
            if self._previous_size is not None and size != self._previous_size:
                first = frame.active_start
            elif (
                self._previous_lines
                and frame.active_start > self._previous_active_start
            ):
                first = min(
                    first if first is not None else len(frame.lines),
                    self._previous_active_start,
                )
            if first is None:
                self._place_cursor(frame)
                self._emit_pending()
                return
            if first == len(self._previous_lines):
                self._append(frame.lines[first:])
            else:
                self._rewrite(first, frame.lines)
            self._previous_lines = frame.lines
            self._previous_active_start = frame.active_start
            self._previous_size = size
            self._max_rows = max(self._max_rows, len(frame.lines))
            self._place_cursor(frame)
            self._emit_pending()
        finally:
            self._pending = None

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
    def _first_changed(previous: tuple[str, ...], current: tuple[str, ...]) -> int | None:
        for index, (old, new) in enumerate(zip(previous, current)):
            if old != new:
                return index
        if len(previous) != len(current):
            return min(len(previous), len(current))
        return None

    def _append(self, lines: tuple[str, ...]) -> None:
        for index, line in enumerate(lines):
            if self._previous_lines or index:
                self._write("\r\n")
                self._hardware_row += 1
            self._write(line)

    def _rewrite(self, first: int, lines: tuple[str, ...]) -> None:
        self._move_to_row(first)
        last = max(len(self._previous_lines), len(lines))
        for index in range(first, last):
            self._write("\r\x1b[2K")
            if index < len(lines):
                self._write(lines[index])
            if index < last - 1:
                self._write("\r\n")
                self._hardware_row += 1

    def _place_cursor(self, frame: ScreenFrame) -> None:
        if not frame.lines:
            return
        target = min(max(frame.cursor_row, 0), len(frame.lines) - 1)
        self._move_to_row(target)
        size = self._previous_size or self._terminal.get_size()
        column = min(max(frame.cursor_col, 0), max(size.columns - 1, 0))
        self._write("\r")
        if column:
            self._write(f"\x1b[{column}C")

    def _move_to_row(self, target: int) -> None:
        delta = target - self._hardware_row
        if delta < 0:
            self._write(f"\x1b[{-delta}A")
        elif delta > 0:
            self._write(f"\x1b[{delta}B")
        if delta:
            self._write("\r")
            self._hardware_row = target

    def _write(self, data: str) -> None:
        if self._pending is None:
            self._terminal.write(data)
        else:
            self._pending.append(data)

    def _emit_pending(self) -> None:
        output = "".join(self._pending or ())
        if output:
            self._terminal.write(output)
        self._terminal.flush()
