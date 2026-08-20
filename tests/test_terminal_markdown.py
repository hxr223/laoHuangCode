import unittest

from laohuangcode.terminal_markdown import render_markdown_lines
from laohuangcode.terminal_theme import PI_DARK


class TerminalMarkdownTests(unittest.TestCase):
    def test_plain_assistant_text_uses_terminal_default_foreground(self):
        rendered = "\n".join(render_markdown_lines("plain response", 80, PI_DARK))

        self.assertIn("plain response", rendered)
        self.assertNotIn("\x1b[38;2;212;212;212mplain response", rendered)


if __name__ == "__main__":
    unittest.main()
