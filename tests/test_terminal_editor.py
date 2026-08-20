import unittest

from laohuangcode.commands import CommandRegistry, CommandSpec
from laohuangcode.terminal_editor import (
    EditorState,
    InputAction,
    InputActionKind,
    RawInputDecoder,
)


class TerminalEditorTests(unittest.TestCase):
    def test_decoder_distinguishes_submit_alt_enter_and_ctrl_d(self):
        decoder = RawInputDecoder()

        self.assertEqual(
            decoder.feed(b"\r"), (InputAction(InputActionKind.SUBMIT),)
        )
        self.assertEqual(
            decoder.feed(b"\x1b\r"), (InputAction(InputActionKind.NEWLINE),)
        )
        self.assertEqual(
            decoder.feed(b"\x04"), (InputAction(InputActionKind.EOF),)
        )

    def test_editor_keeps_slash_candidates_and_tab_accepts_first(self):
        editor = EditorState()
        registry = CommandRegistry((CommandSpec("/exit", "退出程序", "/exit"),))
        editor.apply(InputAction(InputActionKind.INSERT, "/e"), runtime_active=False)
        editor.set_completions(registry.complete(editor.text, state="IDLE"))

        effect = editor.apply(InputAction(InputActionKind.COMPLETE), runtime_active=False)

        self.assertEqual(editor.text, "/exit")
        self.assertIsNone(effect.submit)

    def test_editor_submit_records_history(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "first"), runtime_active=False)

        effect = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)

        self.assertEqual(effect.submit, "first")
        self.assertEqual(editor.history, ("first",))

    def test_render_lines_places_cursor_on_the_newline_row(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "first\n"), runtime_active=False)

        lines, cursor_row, cursor_column = editor.render_lines(20)

        self.assertEqual(lines, ("❯ first", "  "))
        self.assertEqual((cursor_row, cursor_column), (1, 2))
