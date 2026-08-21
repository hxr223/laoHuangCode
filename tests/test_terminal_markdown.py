import unittest

from laohuangcode.terminal_markdown import render_markdown_lines
from laohuangcode.terminal_screen import visible_width
from laohuangcode.terminal_theme import PI_DARK


class TerminalMarkdownTests(unittest.TestCase):
    def test_plain_assistant_text_uses_terminal_default_foreground(self):
        rendered = "\n".join(render_markdown_lines("plain response", 80, PI_DARK))

        self.assertIn("plain response", rendered)
        self.assertNotIn("\x1b[38;2;212;212;212mplain response", rendered)

    def test_markdown_lines_fit_requested_visible_width(self):
        lines = render_markdown_lines(
            "**你好** abcdefghijklmnopqrstuvwxyz `代码`",
            12,
            PI_DARK,
        )

        self.assertTrue(lines)
        self.assertTrue(all(visible_width(line) <= 12 for line in lines))

    def test_markdown_truncation_closes_open_sgr_style(self):
        lines = render_markdown_lines("**你好abcdef**", 5, PI_DARK)

        self.assertEqual(lines, ("\x1b[1m你好a\x1b[0m",))

    def test_markdown_osc8_controls_do_not_count_as_visible_width(self):
        linked = "\x1b]8;;https://example.test\x1b\\abc\x1b]8;;\x1b\\"
        lines = render_markdown_lines(linked, 3, PI_DARK)

        self.assertEqual(tuple(visible_width(line) for line in lines), (3,))


if __name__ == "__main__":
    unittest.main()
