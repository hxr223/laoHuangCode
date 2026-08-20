"""Small ANSI terminal semantics emulator for renderer tests."""

from __future__ import annotations


class TerminalEmulator:
    """Model enough real-terminal behavior to test regular-screen rendering."""

    def __init__(self, *, columns: int, rows: int) -> None:
        if columns < 1 or rows < 1:
            raise ValueError("terminal size must be positive")
        self.columns = columns
        self.rows = rows
        self._screen = [""] * rows
        self._scrollback: list[str] = []
        self._cursor_row = 0
        self._cursor_column = 0
        self._pending_wrap = False

    @property
    def cursor_row(self) -> int:
        return self._cursor_row

    @property
    def cursor_column(self) -> int:
        return self._cursor_column

    @property
    def viewport_top(self) -> int:
        return len(self._scrollback)

    @property
    def scrollback(self) -> tuple[str, ...]:
        return tuple(self._scrollback)

    @property
    def viewport_lines(self) -> tuple[str, ...]:
        return tuple(line.rstrip() for line in self._screen)

    @property
    def logical_lines(self) -> tuple[str, ...]:
        return (*self.scrollback, *self.viewport_lines)

    def write(self, data: str) -> None:
        index = 0
        while index < len(data):
            char = data[index]
            if char == "\x1b":
                index = self._consume_escape(data, index)
                continue
            if char == "\r":
                self._carriage_return()
            elif char == "\n":
                self._line_feed()
            elif char == "\b":
                self._pending_wrap = False
                self._cursor_column = max(0, self._cursor_column - 1)
            elif char >= " ":
                self._print(char)
            else:
                self._pending_wrap = False
            index += 1

    def _consume_escape(self, data: str, start: int) -> int:
        if start + 1 >= len(data):
            self._pending_wrap = False
            return start + 1
        marker = data[start + 1]
        if marker == "[":
            end = start + 2
            while end < len(data) and not ("@" <= data[end] <= "~"):
                end += 1
            if end >= len(data):
                self._pending_wrap = False
                return len(data)
            self._apply_csi(data[start + 2 : end], data[end])
            return end + 1
        if marker in {"]", "P", "_"}:
            return self._consume_string_sequence(data, start + 2)
        self._pending_wrap = False
        return start + 2

    def _consume_string_sequence(self, data: str, start: int) -> int:
        index = start
        while index < len(data):
            if data[index] == "\x07":
                self._pending_wrap = False
                return index + 1
            if data[index : index + 2] == "\x1b\\":
                self._pending_wrap = False
                return index + 2
            index += 1
        self._pending_wrap = False
        return len(data)

    def _apply_csi(self, params: str, final: str) -> None:
        if final in {"h", "l"}:
            self._pending_wrap = False
            return
        if final == "m":
            self._pending_wrap = False
            return
        if final == "A":
            self._move_rows(-self._first_param(params, default=1))
        elif final == "B":
            self._move_rows(self._first_param(params, default=1))
        elif final == "C":
            self._move_columns(self._first_param(params, default=1))
        elif final == "D":
            self._move_columns(-self._first_param(params, default=1))
        elif final == "G":
            self._set_column(self._first_param(params, default=1) - 1)
        elif final in {"H", "f"}:
            row, column = self._row_column_params(params)
            self._set_position(row - 1, column - 1)
        elif final == "K" and self._first_param(params, default=0) == 2:
            self._pending_wrap = False
            self._screen[self._cursor_row] = ""
        elif final == "J":
            mode = self._first_param(params, default=0)
            self._pending_wrap = False
            if mode == 2:
                self._screen = [""] * self.rows
            elif mode == 3:
                self._scrollback.clear()
        else:
            self._pending_wrap = False

    @staticmethod
    def _first_param(params: str, *, default: int) -> int:
        cleaned = params.lstrip("?")
        first = cleaned.split(";", 1)[0]
        if not first:
            return default
        try:
            return int(first)
        except ValueError:
            return default

    @staticmethod
    def _row_column_params(params: str) -> tuple[int, int]:
        values = params.lstrip("?").split(";")
        row = TerminalEmulator._parse_position_value(values, 0)
        column = TerminalEmulator._parse_position_value(values, 1)
        return row, column

    @staticmethod
    def _parse_position_value(values: list[str], index: int) -> int:
        if index >= len(values) or values[index] == "":
            return 1
        try:
            return max(1, int(values[index]))
        except ValueError:
            return 1

    def _print(self, char: str) -> None:
        if self._pending_wrap:
            self._line_feed()
            self._cursor_column = 0
        self._put_char(char)
        if self._cursor_column >= self.columns - 1:
            self._cursor_column = self.columns - 1
            self._pending_wrap = True
        else:
            self._cursor_column += 1
            self._pending_wrap = False

    def _put_char(self, char: str) -> None:
        line = self._screen[self._cursor_row]
        if len(line) < self._cursor_column:
            line = line + (" " * (self._cursor_column - len(line)))
        if len(line) == self._cursor_column:
            line += char
        else:
            line = line[: self._cursor_column] + char + line[self._cursor_column + 1 :]
        self._screen[self._cursor_row] = line[: self.columns]

    def _carriage_return(self) -> None:
        self._pending_wrap = False
        self._cursor_column = 0

    def _line_feed(self) -> None:
        self._pending_wrap = False
        if self._cursor_row == self.rows - 1:
            self._scrollback.append(self._screen.pop(0).rstrip())
            self._screen.append("")
        else:
            self._cursor_row += 1

    def _move_rows(self, amount: int) -> None:
        self._pending_wrap = False
        self._cursor_row = min(max(self._cursor_row + amount, 0), self.rows - 1)

    def _move_columns(self, amount: int) -> None:
        self._pending_wrap = False
        self._cursor_column = min(
            max(self._cursor_column + amount, 0), self.columns - 1
        )

    def _set_column(self, column: int) -> None:
        self._pending_wrap = False
        self._cursor_column = min(max(column, 0), self.columns - 1)

    def _set_position(self, row: int, column: int) -> None:
        self._pending_wrap = False
        self._cursor_row = min(max(row, 0), self.rows - 1)
        self._cursor_column = min(max(column, 0), self.columns - 1)
