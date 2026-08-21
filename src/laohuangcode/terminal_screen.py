"""Incremental renderer for Pi's regular terminal screen."""

from __future__ import annotations

from dataclasses import dataclass
import os
import unicodedata
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
            line_width = visible_width(line)
            if line_width > width:
                raise ValueError(
                    f"rendered line {index} exceeds terminal width "
                    f"({line_width} > {width})"
                )


def visible_width(text: str) -> int:
    if not text:
        return 0
    stripped = strip_terminal_controls(text).replace("\t", "   ")
    return sum(_grapheme_width(cluster) for cluster in _grapheme_clusters(stripped))


def truncate_to_width(text: str, width: int) -> str:
    if width <= 0 or not text:
        return ""
    result: list[str] = []
    sgr_prefix: list[str] = []
    used = 0
    index = 0
    while index < len(text):
        if text[index] == "\x1b":
            end = _consume_escape_sequence(text, index)
            sequence = text[index:end]
            if _is_sgr_sequence(sequence):
                result.append(sequence)
                _update_sgr_prefix(sgr_prefix, sequence)
            index = end
            continue
        next_escape = text.find("\x1b", index)
        end = len(text) if next_escape == -1 else next_escape
        for cluster in _grapheme_clusters(text[index:end]):
            display_cluster, cluster_width = _display_cluster(cluster)
            if used + cluster_width > width:
                if sgr_prefix:
                    result.append("\x1b[0m")
                return "".join(result)
            result.append(display_cluster)
            used += cluster_width
        index = end
    if sgr_prefix:
        result.append("\x1b[0m")
    return "".join(result)


def wrap_text_to_width(text: str, width: int) -> tuple[str, ...]:
    width = max(1, width)
    rows: list[str] = []
    for source_line in text.splitlines() or [""]:
        row_parts: list[str] = []
        row_width = 0
        sgr_prefix: list[str] = []
        index = 0

        def finish_row() -> None:
            if sgr_prefix:
                row_parts.append("\x1b[0m")
            rows.append("".join(row_parts))

        while index < len(source_line):
            if source_line[index] == "\x1b":
                end = _consume_escape_sequence(source_line, index)
                sequence = source_line[index:end]
                if _is_sgr_sequence(sequence):
                    row_parts.append(sequence)
                    _update_sgr_prefix(sgr_prefix, sequence)
                index = end
                continue

            next_escape = source_line.find("\x1b", index)
            end = len(source_line) if next_escape == -1 else next_escape
            for cluster in _grapheme_clusters(source_line[index:end]):
                display_cluster, cluster_width = _display_cluster(cluster)
                if row_width and row_width + cluster_width > width:
                    finish_row()
                    row_parts = list(sgr_prefix)
                    row_width = 0
                if cluster_width > width:
                    continue
                row_parts.append(display_cluster)
                row_width += cluster_width
            index = end
        finish_row()
    return tuple(rows)


def strip_terminal_controls(text: str) -> str:
    result: list[str] = []
    index = 0
    while index < len(text):
        if text[index] != "\x1b":
            result.append(text[index])
            index += 1
            continue
        index = _consume_escape_sequence(text, index)
    return "".join(result)


def _consume_escape_sequence(text: str, start: int) -> int:
    if start + 1 >= len(text):
        return start + 1
    marker = text[start + 1]
    if marker == "[":
        index = start + 2
        while index < len(text):
            if 0x40 <= ord(text[index]) <= 0x7E:
                return index + 1
            index += 1
        return len(text)
    if marker == "]":
        return _consume_string_sequence(text, start + 2, allow_bel=True)
    if marker == "P":
        return _consume_string_sequence(text, start + 2, allow_bel=False)
    if marker == "_":
        return _consume_string_sequence(text, start + 2, allow_bel=True)
    return start + 2


def _consume_string_sequence(text: str, start: int, *, allow_bel: bool) -> int:
    index = start
    while index < len(text):
        if allow_bel and text[index] == "\x07":
            return index + 1
        if text[index : index + 2] == "\x1b\\":
            return index + 2
        index += 1
    return len(text)


def _is_sgr_sequence(sequence: str) -> bool:
    return sequence.startswith("\x1b[") and sequence.endswith("m")


def _update_sgr_prefix(prefix: list[str], sequence: str) -> None:
    raw_params = sequence[2:-1]
    params = tuple(part for part in raw_params.replace(":", ";").split(";") if part)
    if not params or all(param == "0" for param in params):
        prefix.clear()
        return
    if "0" in params:
        prefix[:] = [sequence]
        return
    prefix.append(sequence)


def _display_cluster(cluster: str) -> tuple[str, int]:
    if cluster == "\t":
        return "   ", 3
    return cluster, _grapheme_width(cluster)


def _grapheme_clusters(text: str) -> tuple[str, ...]:
    clusters: list[str] = []
    index = 0
    while index < len(text):
        cluster = text[index]
        index += 1
        if _is_regional_indicator(cluster):
            if index < len(text) and _is_regional_indicator(text[index]):
                cluster += text[index]
                index += 1
            clusters.append(cluster)
            continue
        while index < len(text):
            char = text[index]
            if char == "\u200d" and index + 1 < len(text):
                cluster += char + text[index + 1]
                index += 2
                continue
            if _is_grapheme_extension(char):
                cluster += char
                index += 1
                continue
            break
        clusters.append(cluster)
    return tuple(clusters)


def _grapheme_width(cluster: str) -> int:
    if not cluster:
        return 0
    if (
        "\u200d" in cluster
        or "\ufe0f" in cluster
        or any(_is_regional_indicator(char) for char in cluster)
    ):
        return 2
    return max(0, get_cwidth(cluster))


def _is_grapheme_extension(char: str) -> bool:
    codepoint = ord(char)
    return (
        unicodedata.category(char).startswith("M")
        or 0xFE00 <= codepoint <= 0xFE0F
        or 0x1F3FB <= codepoint <= 0x1F3FF
    )


def _is_regional_indicator(char: str) -> bool:
    codepoint = ord(char)
    return 0x1F1E6 <= codepoint <= 0x1F1FF
