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

    def test_decoder_drops_unknown_controls_and_unrecognized_csi_as_units(self):
        decoder = RawInputDecoder()

        self.assertEqual(
            decoder.feed(bytes([1]) + b"x"),
            (InputAction(InputActionKind.INSERT, "x"),),
        )
        self.assertEqual(decoder.feed(b"\x1b[1"), ())
        self.assertEqual(
            decoder.feed(b"Aok"),
            (InputAction(InputActionKind.INSERT, "ok"),),
        )

    def test_decoder_flushes_standalone_escape_as_completion_dismissal(self):
        decoder = RawInputDecoder()

        self.assertEqual(decoder.feed(b"\x1b"), ())
        self.assertEqual(
            decoder.flush(), (InputAction(InputActionKind.DISMISS),)
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

    def test_completion_overlay_navigates_accepts_with_enter_and_then_submits(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "/"), runtime_active=False)
        editor.set_completions(
            (
                CommandRegistry(
                    (CommandSpec("/exit", "退出", "/exit"),)
                ).complete("/", state="IDLE")[0],
                CommandRegistry(
                    (CommandSpec("/help", "帮助", "/help"),)
                ).complete("/", state="IDLE")[0],
            )
        )

        editor.apply(InputAction(InputActionKind.HISTORY_DOWN), runtime_active=False)
        editor.apply(InputAction(InputActionKind.HISTORY_UP), runtime_active=False)
        editor.apply(InputAction(InputActionKind.HISTORY_DOWN), runtime_active=False)
        accepted = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)
        submitted = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)

        self.assertEqual(editor.history, ("/help",))
        self.assertIsNone(accepted.submit)
        self.assertEqual(submitted.submit, "/help")

    def test_escape_closes_completion_and_cursor_motion_cannot_accept_stale_candidate(self):
        editor = EditorState()
        registry = CommandRegistry((CommandSpec("/model", "模型", "/model"),))
        editor.apply(InputAction(InputActionKind.INSERT, "/mo"), runtime_active=False)
        editor.set_completions(registry.complete(editor.text, state="IDLE"))

        editor.apply(InputAction(InputActionKind.CURSOR_LEFT), runtime_active=False)
        editor.apply(InputAction(InputActionKind.COMPLETE), runtime_active=False)

        self.assertEqual(editor.text, "/mo")
        editor.set_completions(registry.complete(editor.text, state="IDLE"))
        editor.apply(InputAction(InputActionKind.DISMISS), runtime_active=False)
        self.assertFalse(editor.completion_visible)

    def test_render_lines_places_cursor_on_the_newline_row(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "first\n"), runtime_active=False)

        lines, cursor_row, cursor_column = editor.render_lines(20)

        self.assertEqual(lines, ("❯ first", "  "))
        self.assertEqual((cursor_row, cursor_column), (1, 2))
