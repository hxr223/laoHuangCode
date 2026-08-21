import unittest

from laohuangcode.commands import CommandRegistry, CommandSpec
from laohuangcode.terminal_editor import (
    BufferedInputKind,
    EditorState,
    InputAction,
    InputActionKind,
    RawInputDecoder,
    StdinBuffer,
    TerminalInputFilter,
)


class TerminalEditorTests(unittest.TestCase):
    def _decode_buffered(
        self,
        chunks: tuple[bytes, ...],
        *,
        filter_: TerminalInputFilter | None = None,
    ) -> tuple[InputAction, ...]:
        buffer = StdinBuffer()
        input_filter = filter_ or TerminalInputFilter()
        decoder = RawInputDecoder()
        actions: list[InputAction] = []
        for chunk in chunks:
            for event in buffer.feed(chunk):
                if event.kind is BufferedInputKind.PASTE:
                    actions.append(
                        InputAction(
                            InputActionKind.INSERT,
                            event.data.decode("utf-8"),
                        )
                    )
                    continue
                for sequence in input_filter.feed(event.data):
                    actions.extend(decoder.feed(sequence))
        return tuple(actions)

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

    def test_stdin_filter_drops_split_device_attributes_response(self):
        actions = self._decode_buffered((b"\x1b", b"[?1;2c"))

        self.assertEqual(actions, ())

    def test_stdin_filter_drops_abandoned_prefix_before_real_input(self):
        typed = self._decode_buffered((b"\x1b[?1;", b"a"))
        arrow = self._decode_buffered((b"\x1b[?1;", b"\x1b[A"))

        self.assertEqual(typed, (InputAction(InputActionKind.INSERT, "a"),))
        self.assertEqual(arrow, (InputAction(InputActionKind.HISTORY_UP),))

    def test_stdin_buffer_emits_split_bracketed_paste_as_content_only(self):
        actions = self._decode_buffered((b"\x1b[200~hello\n", b"world\x1b[201~"))

        self.assertEqual(
            actions,
            (InputAction(InputActionKind.INSERT, "hello\nworld"),),
        )

    def test_stdin_buffer_keeps_ordinary_arrow_keys_mapped(self):
        actions = self._decode_buffered((b"\x1b", b"[A"))

        self.assertEqual(actions, (InputAction(InputActionKind.HISTORY_UP),))

    def test_stdin_buffer_flushes_standalone_escape_as_dismissal(self):
        buffer = StdinBuffer()
        input_filter = TerminalInputFilter()
        decoder = RawInputDecoder()

        self.assertEqual(buffer.feed(b"\x1b"), ())
        actions: list[InputAction] = []
        for event in buffer.flush():
            for sequence in input_filter.feed(event.data):
                actions.extend(decoder.feed(sequence))
        actions.extend(decoder.flush())

        self.assertEqual(tuple(actions), (InputAction(InputActionKind.DISMISS),))

    def test_stdin_buffer_preserves_cjk_insert(self):
        actions = self._decode_buffered(("你好".encode(),))

        self.assertEqual("".join(action.text for action in actions), "你好")

    def test_bracketed_paste_newlines_insert_instead_of_submitting(self):
        editor = EditorState()
        actions = self._decode_buffered((b"\x1b[200~one\ntwo\x1b[201~",))

        effects = [
            editor.apply(action, runtime_active=False)
            for action in actions
        ]

        self.assertEqual(editor.text, "one\ntwo")
        self.assertTrue(all(effect.submit is None for effect in effects))

    def test_apple_terminal_shift_enter_normalizes_to_newline(self):
        filter_ = TerminalInputFilter(
            is_apple_terminal=lambda: True,
            shift_pressed=lambda: True,
        )

        actions = self._decode_buffered((b"\r",), filter_=filter_)

        self.assertEqual(actions, (InputAction(InputActionKind.NEWLINE),))

    def test_kitty_release_is_filtered_and_repeat_maps_to_printable(self):
        release = self._decode_buffered((b"\x1b[65;1:3u",))
        repeat = self._decode_buffered((b"\x1b[65;1:2u",))

        self.assertEqual(release, ())
        self.assertEqual(repeat, (InputAction(InputActionKind.INSERT, "A"),))

    def test_kitty_arrow_press_repeat_and_release(self):
        press = self._decode_buffered((b"\x1b[1;1A",))
        repeat = self._decode_buffered((b"\x1b[1;1:2C",))
        release = self._decode_buffered((b"\x1b[1;1:3A",))

        self.assertEqual(press, (InputAction(InputActionKind.HISTORY_UP),))
        self.assertEqual(repeat, (InputAction(InputActionKind.CURSOR_RIGHT),))
        self.assertEqual(release, ())

    def test_unmodified_kitty_printable_suppresses_raw_duplicate(self):
        actions = self._decode_buffered((b"\x1b[97u", b"a"))

        self.assertEqual(actions, (InputAction(InputActionKind.INSERT, "a"),))

    def test_unmodified_kitty_printable_suppresses_batched_raw_duplicate(self):
        actions = self._decode_buffered((b"\x1b[97u", b"ab"))

        self.assertEqual(
            actions,
            (
                InputAction(InputActionKind.INSERT, "a"),
                InputAction(InputActionKind.INSERT, "b"),
            ),
        )

    def test_high_bit_meta_byte_is_converted_before_buffering(self):
        actions = self._decode_buffered((bytes([0xE1]),))

        self.assertEqual(actions, (InputAction(InputActionKind.INSERT, "a"),))

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

    def test_completion_overlay_enter_accepts_slash_command_and_submits(self):
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
        submitted = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)
        empty = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)

        self.assertEqual(editor.history, ("/help",))
        self.assertEqual(submitted.submit, "/help")
        self.assertIsNone(empty.submit)

    def test_enter_submits_when_input_exactly_matches_slash_completion(self):
        editor = EditorState()
        registry = CommandRegistry((CommandSpec("/exit", "退出程序", "/exit"),))
        editor.apply(InputAction(InputActionKind.INSERT, "/exit"), runtime_active=False)
        editor.set_completions(registry.complete(editor.text, state="IDLE"))

        effect = editor.apply(InputAction(InputActionKind.SUBMIT), runtime_active=False)

        self.assertEqual(effect.submit, "/exit")
        self.assertEqual(editor.history, ("/exit",))

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

    def test_text_mutation_closes_completion_before_tab_can_use_a_stale_offset(self):
        editor = EditorState()
        registry = CommandRegistry((CommandSpec("/echo", "回显", "/echo"),))
        editor.apply(InputAction(InputActionKind.INSERT, "/e"), runtime_active=False)
        editor.set_completions(registry.complete(editor.text, state="IDLE"))

        editor.apply(InputAction(InputActionKind.INSERT, "x"), runtime_active=False)
        editor.apply(InputAction(InputActionKind.COMPLETE), runtime_active=False)

        self.assertEqual(editor.text, "/ex")
        self.assertFalse(editor.completion_visible)

    def test_completion_rows_equal_visible_candidates(self):
        editor = EditorState()
        registry = CommandRegistry(
            (
                CommandSpec("/exit", "退出程序", "/exit"),
                CommandSpec("/help", "帮助", "/help"),
            )
        )
        editor.apply(InputAction(InputActionKind.INSERT, "/"), runtime_active=False)
        editor.set_completions(registry.complete(editor.text, state="IDLE"))

        self.assertEqual(len(editor.completions), 2)
        editor.apply(InputAction(InputActionKind.INSERT, "x"), runtime_active=False)

        self.assertEqual(len(editor.completions), 0)

    def test_ctrl_d_exits_only_for_idle_empty_editor(self):
        editor = EditorState()

        running = editor.apply(InputAction(InputActionKind.EOF), runtime_active=True)
        idle = editor.apply(InputAction(InputActionKind.EOF), runtime_active=False)

        self.assertFalse(running.exit_requested)
        self.assertTrue(idle.exit_requested)

    def test_render_lines_places_cursor_on_the_newline_row(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "first\n"), runtime_active=False)

        lines, cursor_row, cursor_column = editor.render_lines(20)

        self.assertEqual(lines, ("❯ first", "  "))
        self.assertEqual((cursor_row, cursor_column), (1, 2))

    def test_render_lines_wraps_cjk_by_terminal_cell_width(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "你好你"), runtime_active=False)

        lines, cursor_row, cursor_column = editor.render_lines(7)

        self.assertEqual(lines, ("❯ 你好", "  你"))
        self.assertEqual((cursor_row, cursor_column), (1, 4))

    def test_render_lines_places_cursor_after_exact_width_wrap(self):
        editor = EditorState()
        editor.apply(InputAction(InputActionKind.INSERT, "你好a"), runtime_active=False)

        lines, cursor_row, cursor_column = editor.render_lines(7)

        self.assertEqual(lines, ("❯ 你好a", "  "))
        self.assertEqual((cursor_row, cursor_column), (1, 2))
