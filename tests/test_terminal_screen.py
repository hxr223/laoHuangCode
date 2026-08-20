import unittest

from laohuangcode.terminal_screen import (
    MemoryTerminalDriver,
    PiMainScreenRenderer,
    ScreenFrame,
)
from tests.terminal_emulator import TerminalEmulator


class PiMainScreenRendererTests(unittest.TestCase):
    def test_emulator_scrolls_when_linefeed_writes_at_bottom_row(self):
        terminal = TerminalEmulator(columns=10, rows=2)

        terminal.write("top\r\nbottom\r\nnext")

        self.assertEqual(terminal.scrollback, ("top",))
        self.assertEqual(terminal.viewport_lines, ("bottom", "next"))
        self.assertEqual(terminal.cursor_row, 1)
        self.assertEqual(terminal.cursor_column, 4)
        self.assertEqual(terminal.viewport_top, 1)

    def test_emulator_wraps_only_after_next_printable_full_width_line(self):
        terminal = TerminalEmulator(columns=4, rows=3)

        terminal.write("abcd")

        self.assertEqual(terminal.viewport_lines, ("abcd", "", ""))
        self.assertEqual(terminal.cursor_row, 0)
        self.assertEqual(terminal.cursor_column, 3)

        terminal.write("X")

        self.assertEqual(terminal.viewport_lines, ("abcd", "X", ""))
        self.assertEqual(terminal.cursor_row, 1)
        self.assertEqual(terminal.cursor_column, 1)

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

        self.assertIn("\x1b[5G", terminal.writes())

    def test_cursor_column_uses_terminal_cells_not_python_string_length(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("❯ 你好你",), 0, 0, cursor_col=8))

        self.assertIn("\x1b[9G", terminal.writes())
        self.assertNotIn("\x1b[6G", terminal.writes())

    def test_render_emits_one_atomic_terminal_write(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("─" * 80, "❯ a", "─" * 80), 1, 1, 3))
        terminal.clear_writes()

        renderer.render(ScreenFrame(("─" * 80, "❯ as", "─" * 80), 1, 1, 4))

        self.assertEqual(len(terminal.write_chunks()), 1)
        self.assertIn("\x1b[2K❯ as", terminal.writes())

    def test_diff_render_uses_synchronized_output_wrappers(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("one", "❯ a"), 1, 1, 3))
        terminal.clear_writes()

        renderer.render(ScreenFrame(("one", "❯ as"), 1, 1, 4))

        self.assertTrue(terminal.writes().startswith("\x1b[?2026h"))
        self.assertIn("\x1b[?2026l", terminal.writes())

    def test_editor_only_change_does_not_repaint_unchanged_footer_rows(self):
        terminal = MemoryTerminalDriver(columns=80, rows=4)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("─" * 80, "❯ a", "─" * 80), 1, 1, 3))
        terminal.clear_writes()

        renderer.render(ScreenFrame(("─" * 80, "❯ as", "─" * 80), 1, 1, 4))

        self.assertEqual(terminal.writes().count("\x1b[2K"), 1)
        self.assertNotIn("\r\n", terminal.writes())
        self.assertNotIn("─" * 80, terminal.writes())

    def test_full_width_separator_rows_do_not_duplicate_prompts_semantically(self):
        terminal = MemoryTerminalDriver(columns=80, rows=4)
        emulator = TerminalEmulator(columns=80, rows=4)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("─" * 80, "❯ a", "─" * 80), 1, 1, 3))
        emulator.write(terminal.writes())
        terminal.clear_writes()

        renderer.render(ScreenFrame(("─" * 80, "❯ as", "─" * 80), 1, 1, 4))
        emulator.write(terminal.writes())

        rendered = "\n".join(emulator.logical_lines)
        self.assertEqual(rendered.count("❯ "), 1)
        self.assertEqual(emulator.viewport_lines[:3], ("─" * 80, "❯ as", "─" * 80))
        self.assertNotIn("❯ a", emulator.logical_lines)

    def test_changed_line_above_previous_viewport_uses_full_render(self):
        terminal = MemoryTerminalDriver(columns=80, rows=2)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("old", "middle", "tail", "❯ "), 3, 3))
        terminal.clear_writes()

        renderer.render(ScreenFrame(("new", "middle", "tail", "❯ "), 3, 3))

        self.assertIn("\x1b[2J\x1b[H\x1b[3J", terminal.writes())
        self.assertIn("new", terminal.writes())

    def test_cursor_only_update_flushes_terminal_output(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("one", "two"), 1, 1))
        flushes_before = terminal.flushes

        renderer.render(ScreenFrame(("one", "two"), 1, 0))

        self.assertEqual(terminal.flushes, flushes_before + 1)

    def test_resize_uses_pi_full_render_clear_path(self):
        terminal = MemoryTerminalDriver(columns=80, rows=24)
        renderer = PiMainScreenRenderer(terminal)
        renderer.render(ScreenFrame(("saved history", "active", "❯ "), 2, 2))
        terminal.resize(columns=40, rows=24)
        terminal.clear_writes()

        renderer.render(ScreenFrame(("saved history", "active", "❯ "), 2, 2))

        self.assertIn("\x1b[2J\x1b[H\x1b[3J", terminal.writes())
        self.assertIn("saved history", terminal.writes())
        self.assertNotIn("\x1b[2K", terminal.writes())

    def test_over_width_line_raises_before_writing(self):
        terminal = MemoryTerminalDriver(columns=4, rows=2)
        renderer = PiMainScreenRenderer(terminal)

        with self.assertRaisesRegex(ValueError, "exceeds terminal width"):
            renderer.render(ScreenFrame(("12345",), 0, 0))

        self.assertEqual(terminal.writes(), "")

    def test_osc8_visible_text_counts_toward_width(self):
        terminal = MemoryTerminalDriver(columns=4, rows=2)
        renderer = PiMainScreenRenderer(terminal)
        linked = "\x1b]8;;https://example.test\x1b\\12345\x1b]8;;\x1b\\"

        with self.assertRaisesRegex(ValueError, "exceeds terminal width"):
            renderer.render(ScreenFrame((linked,), 0, 0))

        self.assertEqual(terminal.writes(), "")

    def test_zwj_emoji_cluster_uses_terminal_cell_width(self):
        terminal = MemoryTerminalDriver(columns=2, rows=2)
        renderer = PiMainScreenRenderer(terminal)

        renderer.render(ScreenFrame(("👨‍👩‍👧‍👦",), 0, 0))

        self.assertIn("👨‍👩‍👧‍👦", terminal.writes())

    def test_flag_emoji_cluster_uses_terminal_cell_width(self):
        terminal = MemoryTerminalDriver(columns=2, rows=2)
        renderer = PiMainScreenRenderer(terminal)

        renderer.render(ScreenFrame(("🇨🇳",), 0, 0))

        self.assertIn("🇨🇳", terminal.writes())

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
