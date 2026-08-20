import unittest

from laohuangcode.terminal_screen import (
    MemoryTerminalDriver,
    PiMainScreenRenderer,
    ScreenFrame,
)


class PiMainScreenRendererTests(unittest.TestCase):
    def test_new_completed_lines_append_without_erasing_scrollback(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)

        renderer.render(ScreenFrame(("user one", "answer one", "❯ "), 2, 2))
        terminal.clear_writes()
        renderer.render(
            ScreenFrame(("user one", "answer one", "user two", "❯ "), 3, 2)
        )

        self.assertIn("user two", terminal.writes())
        self.assertIn("\x1b[2K", terminal.writes())
        self.assertNotIn("\x1b[2J", terminal.writes())
        self.assertNotIn("\x1b[3J", terminal.writes())

    def test_stream_delta_repaints_only_changed_active_tail(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(
            ScreenFrame(("user one", "answer one", "answer two: hel", "❯ "), 3, 2)
        )
        terminal.clear_writes()

        renderer.render(
            ScreenFrame(("user one", "answer one", "answer two: hello", "❯ "), 3, 2)
        )

        self.assertIn("\x1b[2K", terminal.writes())
        self.assertIn("answer two: hello", terminal.writes())
        self.assertNotIn("answer one", terminal.writes())

    def test_completed_active_line_is_rewritten_in_place_without_duplication(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("user", "answer: hel", "❯ "), 1, 2))
        terminal.clear_writes()

        renderer.render(ScreenFrame(("user", "answer: hello", "❯ "), 2, 2))

        self.assertIn("\x1b[2Kanswer: hello", terminal.writes())
        self.assertEqual(terminal.writes().count("answer: hello"), 1)
        self.assertNotIn("\x1b[2J", terminal.writes())
        self.assertNotIn("\x1b[3J", terminal.writes())

    def test_cursor_column_is_positioned_within_the_selected_line(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("history", "❯ edit"), 1, 1, cursor_col=0))
        terminal.clear_writes()

        renderer.render(ScreenFrame(("history", "❯ edit"), 1, 1, cursor_col=4))

        self.assertIn("\r\x1b[4C", terminal.writes())

    def test_cursor_only_update_flushes_terminal_output(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("one", "two"), 1, 1))
        flushes_before = terminal.flushes

        renderer.render(ScreenFrame(("one", "two"), 1, 0))

        self.assertEqual(terminal.flushes, flushes_before + 1)

    def test_resize_never_clears_scrollback(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("saved history", "active", "❯ "), 2, 2))
        terminal.resize(columns=40, rows=24)
        terminal.clear_writes()

        renderer.render(ScreenFrame(("saved history", "active", "❯ "), 2, 2))

        self.assertNotIn("\x1b[3J", terminal.writes())
        self.assertNotIn("saved history", terminal.writes())
        self.assertIn("\x1b[2K", terminal.writes())

    def test_close_restores_driver_and_cursor(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.close()

        self.assertTrue(terminal.restored)
        self.assertIn("\x1b[?25h", terminal.writes())
        renderer.close()
        self.assertEqual(terminal.restore_calls, 1)

    def test_close_restores_driver_when_cursor_write_fails(self):
        class BrokenWriteTerminal(MemoryTerminalDriver):
            def write(self, data: str) -> None:
                raise BrokenPipeError("closed")

        terminal = BrokenWriteTerminal(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)

        with self.assertRaises(BrokenPipeError):
            renderer.close()

        self.assertTrue(terminal.restored)


if __name__ == "__main__":
    unittest.main()
