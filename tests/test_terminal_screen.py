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

        self.assertIn("\r\nuser two", terminal.writes())
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


if __name__ == "__main__":
    unittest.main()
