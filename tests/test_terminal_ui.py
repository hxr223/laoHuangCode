from concurrent.futures import Future
import io
from pathlib import Path
from types import SimpleNamespace
import threading
import time
import unittest

from prompt_toolkit import PromptSession
from prompt_toolkit.data_structures import Size
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.layout.screen import WritePosition
from prompt_toolkit.output import DummyOutput
from prompt_toolkit.output.vt100 import Vt100_Output
from rich.console import Console

from laohuangcode.commands import CommandCompleter, CommandRegistry, CommandSpec
from laohuangcode.terminal_input import PiInputSession, PiTerminalApplication
from laohuangcode.terminal_ui import PlainEventSink, TerminalUI, _input_bindings
from laohuangcode.ui_state import UIUpdate


class TerminalUITests(unittest.TestCase):
    def test_plain_sink_outputs_one_complete_model_response(self):
        output = []
        sink = PlainEventSink(output.append)
        base = {
            "source": "model",
            "session_id": "session-1",
            "task_id": "task-1",
            "correlation_id": "request-1",
            "sequence": 1,
        }
        sink.publish_event(
            {
                **base,
                "kind": "model.text_delta",
                "payload": {"text": "hello "},
            }
        )
        sink.publish_event(
            {
                **base,
                "kind": "model.text_delta",
                "payload": {"text": "world"},
            }
        )
        sink.publish_event(
            {
                **base,
                "kind": "model.response_committed",
                "payload": {},
            }
        )
        sink.flush()
        sink.stop()

        self.assertEqual(output, ["hello world"])

    def test_real_prompt_frame_is_compact_and_has_both_borders(self):
        class TTYBuffer(io.StringIO):
            def isatty(self):
                return True

        output_buffer = TTYBuffer()
        output = Vt100_Output(
            output_buffer,
            lambda: Size(rows=40, columns=60),
            term="xterm",
            enable_cpr=False,
        )
        with create_pipe_input() as pipe:
            ui = TerminalUI(
                console=Console(file=io.StringIO(), force_terminal=False),
                session_factory=lambda **options: PromptSession(
                    input=pipe,
                    output=output,
                    **options,
                ),
            )

            def prompt() -> None:
                try:
                    ui.prompt()
                except EOFError:
                    pass

            worker = threading.Thread(target=prompt)
            worker.start()
            time.sleep(0.05)
            rendered = output_buffer.getvalue()
            pipe.send_bytes(b"\x04")
            worker.join(1)

        self.assertIn("┌", rendered)
        self.assertIn("└", rendered)
        self.assertIn("│", rendered)
        self.assertLessEqual(rendered.count("\r\n"), 3)

    def test_pi_input_session_uses_horizontal_borders_without_side_edges(self):
        class TTYBuffer(io.StringIO):
            def isatty(self):
                return True

        output_buffer = TTYBuffer()
        output = Vt100_Output(
            output_buffer,
            lambda: Size(rows=20, columns=60),
            term="xterm",
            enable_cpr=False,
        )
        with create_pipe_input() as pipe:
            session = PiInputSession(input=pipe, output=output)
            result = []
            worker = threading.Thread(target=lambda: result.append(session.prompt()))
            worker.start()
            time.sleep(0.05)
            pipe.send_text("hello")
            pipe.send_bytes(b"\r")
            worker.join(1)

        rendered = output_buffer.getvalue()
        self.assertEqual(result, ["hello"])
        self.assertIn("─", rendered)
        self.assertIn("❯", rendered)
        self.assertNotIn("│", rendered)

    def test_persistent_terminal_owns_transcript_and_editor_together(self):
        class TTYBuffer(io.StringIO):
            def isatty(self):
                return True

        output_buffer = TTYBuffer()
        output = Vt100_Output(
            output_buffer,
            lambda: Size(rows=20, columns=60),
            term="xterm",
            enable_cpr=False,
        )
        submitted = []
        with create_pipe_input() as pipe:
            app = PiTerminalApplication(
                input=pipe,
                output=output,
                transcript=lambda _width, _height: [
                    ("#1f2328", "`laoHuangCode` 项目根目录\n")
                ],
            )

            def run() -> None:
                app.run(lambda text: (submitted.append(text), app.exit()))

            worker = threading.Thread(target=run)
            worker.start()
            time.sleep(0.05)
            pipe.send_text("hello")
            pipe.send_bytes(b"\r")
            worker.join(1)

        self.assertEqual(submitted, ["hello"])
        self.assertIn("`laoHuangCode` 项目根目录", output_buffer.getvalue())

    def test_persistent_terminal_stays_in_the_regular_terminal_screen(self):
        """A normal session must not switch to prompt_toolkit's alt screen."""

        class TTYBuffer(io.StringIO):
            def isatty(self):
                return True

        output_buffer = TTYBuffer()
        output = Vt100_Output(
            output_buffer,
            lambda: Size(rows=40, columns=60),
            term="xterm",
            enable_cpr=False,
        )
        with create_pipe_input() as pipe:
            app = PiTerminalApplication(
                input=pipe,
                output=output,
                transcript=lambda _width, _height: [],
            )
            worker = threading.Thread(target=lambda: app.run(lambda _text: None))
            worker.start()
            time.sleep(0.05)
            app.exit()
            worker.join(1)

        self.assertFalse(worker.is_alive())
        self.assertNotIn("\x1b[?1049h", output_buffer.getvalue())

    def test_persistent_terminal_ignores_a_repeated_exit_request(self):
        class FakeApplication:
            def __init__(self):
                self.future = Future()
                self.loop = None
                self.exit_calls = 0

            def exit(self):
                if self.future.done():
                    raise Exception("Return value already set")
                self.exit_calls += 1
                self.future.set_result(None)

        terminal = PiTerminalApplication(
            transcript=lambda _width, _height: [],
        )
        application = FakeApplication()
        terminal.app = application
        terminal._running.set()

        terminal.exit()
        terminal.exit()

        self.assertEqual(application.exit_calls, 1)

    def test_persistent_terminal_keeps_command_completion_compact(self):
        class TTYBuffer(io.StringIO):
            def isatty(self):
                return True

        output_buffer = TTYBuffer()
        output = Vt100_Output(
            output_buffer,
            lambda: Size(rows=40, columns=60),
            term="xterm",
            enable_cpr=False,
        )
        registry = CommandRegistry(
            [CommandSpec("/exit", "退出程序", "/exit")]
        )
        with create_pipe_input() as pipe:
            app = PiTerminalApplication(
                input=pipe,
                output=output,
                transcript=lambda _width, _height: [],
                completer=CommandCompleter(registry),
                complete_while_typing=True,
            )
            worker = threading.Thread(target=lambda: app.run(lambda _text: None))
            worker.start()
            time.sleep(0.05)
            pipe.send_text("/e")
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                state = app.default_buffer.complete_state
                values = (
                    tuple(item.text for item in state.completions)
                    if state is not None
                    else ()
                )
                if values == ("/exit",):
                    break
                time.sleep(0.01)
            app.exit()
            worker.join(1)

        rendered = output_buffer.getvalue()
        self.assertEqual(values, ("/exit",))
        self.assertIn("/exit", rendered)
        self.assertLessEqual(rendered.count("\r\n"), 6)

    def test_persistent_terminal_uses_only_content_rows_for_a_completion(self):
        registry = CommandRegistry(
            [CommandSpec("/exit", "退出程序", "/exit")]
        )
        with create_pipe_input() as pipe:
            app = PiTerminalApplication(
                input=pipe,
                output=DummyOutput(),
                transcript=lambda _width, _height: [
                    ("", "header\n"),
                    ("", "model"),
                ],
                footer=lambda: [("", "deepseek/deepseek-v4-flash")],
                completer=CommandCompleter(registry),
                complete_while_typing=True,
            )
            worker = threading.Thread(target=lambda: app.run(lambda _text: None))
            worker.start()
            time.sleep(0.05)
            pipe.send_text("/e")
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                state = app.default_buffer.complete_state
                values = (
                    tuple(item.text for item in state.completions)
                    if state is not None
                    else ()
                )
                if values == ("/exit",):
                    break
                time.sleep(0.01)
            rows = app.app.layout.container._divide_heights(
                WritePosition(0, 0, 80, 60)
            )
            app.exit()
            worker.join(1)

        self.assertEqual(values, ("/exit",))
        self.assertEqual(rows, [2, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])

    def test_persistent_terminal_grows_only_for_actual_multiline_input(self):
        with create_pipe_input() as pipe:
            app = PiTerminalApplication(
                input=pipe,
                output=DummyOutput(),
                transcript=lambda _width, _height: [
                    ("", "header\n"),
                    ("", "model"),
                ],
            )
            worker = threading.Thread(target=lambda: app.run(lambda _text: None))
            worker.start()
            time.sleep(0.05)
            app.default_buffer.text = "first line\nsecond line"
            rows = app.app.layout.container._divide_heights(
                WritePosition(0, 0, 80, 60)
            )
            app.exit()
            worker.join(1)

        self.assertEqual(rows, [2, 0, 1, 0, 2, 0, 1, 0, 0])

    def test_persistent_terminal_reuses_editor_for_command_questions(self):
        class TTYBuffer(io.StringIO):
            def isatty(self):
                return True

        output_buffer = TTYBuffer()
        output = Vt100_Output(
            output_buffer,
            lambda: Size(rows=20, columns=60),
            term="xterm",
            enable_cpr=False,
        )
        with create_pipe_input() as pipe:
            app = PiTerminalApplication(
                input=pipe,
                output=output,
                transcript=lambda _width, _height: [],
            )
            runner = threading.Thread(target=lambda: app.run(lambda _text: None))
            runner.start()
            time.sleep(0.05)
            answers = []
            asker = threading.Thread(
                target=lambda: answers.append(app.ask("Select model:"))
            )
            asker.start()
            time.sleep(0.05)
            pipe.send_text("1")
            pipe.send_bytes(b"\r")
            asker.join(1)
            app.exit()
            runner.join(1)

        self.assertEqual(answers, ["1"])
        self.assertIn("Select model:", output_buffer.getvalue())

    def test_single_renderer_keeps_stream_text_across_tool_boundaries(self):
        ui = TerminalUI(theme="light")
        ui._apply_transcript_update(
            UIUpdate("model.reasoning_delta", text="thinking", correlation_id="r1")
        )
        ui._apply_transcript_update(
            UIUpdate(
                "tool.started",
                correlation_id="tool-1",
                payload={"name": "bash", "arguments": {"command": "ls -la"}},
            )
        )
        ui._apply_transcript_update(
            UIUpdate(
                "tool.finished",
                correlation_id="tool-1",
                payload={"status": "completed", "exit_code": 0, "duration_ms": 1},
            )
        )
        ui._apply_transcript_update(
            UIUpdate(
                "model.text_delta",
                text="`laoHuangCode` 项目根目录",
                correlation_id="r2",
            )
        )

        rendered = "".join(text for _style, text in ui._render_transcript(60, 30))

        self.assertIn("laoHuangCode 项目根目录", rendered)
        self.assertNotIn("`", rendered)
        self.assertIn("completed · exit 0 · 1ms", rendered)
        self.assertNotIn("very long output", rendered)

    def test_single_renderer_renders_assistant_markdown(self):
        ui = TerminalUI(theme="dark")
        ui._apply_transcript_update(
            UIUpdate(
                "model.text_delta",
                text="**加粗**、`代码`\n\n- 第一项",
                correlation_id="response-1",
            )
        )

        fragments = ui._render_transcript(80, 30)
        rendered = "".join(text for _style, text in fragments)

        self.assertIn("加粗", rendered)
        self.assertIn("代码", rendered)
        self.assertIn("第一项", rendered)
        self.assertNotIn("**", rendered)
        self.assertNotIn("`", rendered)
        self.assertTrue(
            any("bold" in style and "加粗" in text for style, text in fragments)
        )
        self.assertTrue(
            any("bg:" in style and "代码" in text for style, text in fragments)
        )
        self.assertFalse(
            any(
                "\n" not in text and text.strip() == "" and len(text) > 1
                for _style, text in fragments
            )
        )

    def test_typing_slash_opens_command_completion_immediately(self):
        calls = []

        class Buffer:
            text = ""
            cursor_position = 0

            def insert_text(self, text):
                self.text += text
                self.cursor_position += len(text)

            def start_completion(self, *, select_first):
                calls.append(select_first)

        binding = next(
            item
            for item in _input_bindings().bindings
            if item.keys == ("/",)
        )
        buffer = Buffer()

        binding.handler(SimpleNamespace(current_buffer=buffer))

        self.assertEqual(buffer.text, "/")
        self.assertEqual(calls, [False])

    def test_real_prompt_keeps_slash_completions_live_while_typing(self):
        registry = CommandRegistry(
            [
                CommandSpec("/help", "show help", "/help"),
                CommandSpec(
                    "/model",
                    "choose model",
                    "/model",
                    argument_completer=lambda _arguments: (
                        ("deepseek", "model provider"),
                        ("openai", "model provider"),
                    ),
                ),
            ]
        )
        with create_pipe_input() as pipe:
            ui = TerminalUI(
                console=Console(file=io.StringIO(), force_terminal=False),
                command_registry=registry,
                session_factory=lambda **options: PromptSession(
                    input=pipe,
                    output=DummyOutput(),
                    **options,
                ),
            )
            errors = []

            def prompt() -> None:
                try:
                    ui.prompt()
                except EOFError:
                    pass
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(target=prompt)
            worker.start()
            time.sleep(0.05)

            snapshots = []
            for text in ("/", "h", "e"):
                pipe.send_text(text)
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    state = ui._session.default_buffer.complete_state
                    values = (
                        tuple(item.text for item in state.completions)
                        if state is not None
                        else ()
                    )
                    expected = ("/help", "/model") if text == "/" else ("/help",)
                    if values == expected:
                        break
                    time.sleep(0.01)
                snapshots.append(values)

            pipe.send_bytes(b"\x7f")
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                state = ui._session.default_buffer.complete_state
                backspace_values = (
                    tuple(item.text for item in state.completions)
                    if state is not None
                    else ()
                )
                if backspace_values == ("/help",):
                    break
                time.sleep(0.01)

            pipe.send_bytes(b"\x15")
            pipe.send_text("/model d")
            deadline = time.monotonic() + 1
            argument_values = ()
            argument_meta = ""
            while time.monotonic() < deadline:
                state = ui._session.default_buffer.complete_state
                argument_values = (
                    tuple(item.text for item in state.completions)
                    if state is not None
                    else ()
                )
                if argument_values == ("deepseek",):
                    argument_meta = str(state.completions[0].display_meta)
                    break
                time.sleep(0.01)

            pipe.send_bytes(b"\x15")
            pipe.send_bytes(b"\x04")
            worker.join(1)

        self.assertFalse(errors)
        self.assertEqual(
            snapshots,
            [("/help", "/model"), ("/help",), ("/help",)],
        )
        self.assertEqual(backspace_values, ("/help",))
        self.assertEqual(argument_values, ("deepseek",))
        self.assertIn("model provider", argument_meta)

    def test_assistant_response_is_rendered_as_markdown_without_chat_prefix(self):
        stream = io.StringIO()
        ui = TerminalUI(
            console=Console(
                file=stream,
                color_system=None,
                force_terminal=False,
                width=100,
            )
        )

        ui.show_assistant("**Fixed** `calculator.py`")

        rendered = stream.getvalue()
        self.assertIn("Fixed", rendered)
        self.assertIn("calculator.py", rendered)
        self.assertNotIn("laoHuangCode>", rendered)

    def test_prompt_uses_multiline_editing_and_session_history(self):
        options = {}
        stream = io.StringIO()

        class FakeSession:
            def prompt(self):
                return "first line\nsecond line"

        def session_factory(**kwargs):
            options.update(kwargs)
            return FakeSession()

        ui = TerminalUI(
            console=Console(file=stream, force_terminal=False),
            session_factory=session_factory,
        )

        value = ui.prompt()

        self.assertEqual(value, "first line\nsecond line")
        self.assertTrue(options["multiline"])
        self.assertTrue(options["show_frame"])
        self.assertTrue(options["erase_when_done"])
        self.assertIn("first line", stream.getvalue())
        self.assertIn("second line", stream.getvalue())
        self.assertFalse(options["enable_history_search"])
        self.assertIn("❯", str(options["message"]()))
        self.assertNotIn("bottom_toolbar", options)
        self.assertIsNotNone(options["history"])
        self.assertIsNotNone(options["key_bindings"])

    def test_selection_questions_do_not_replace_the_task_prompt(self):
        created_sessions = []

        class FakeSession:
            def __init__(self, answer):
                self.answer = answer

            def prompt(self, **_kwargs):
                return self.answer

        def session_factory(**options):
            created_sessions.append(options)
            answer = "1" if not options["multiline"] else "/exit"
            return FakeSession(answer)

        ui = TerminalUI(
            console=Console(file=io.StringIO(), force_terminal=False),
            session_factory=session_factory,
        )

        self.assertEqual(ui.prompt("Select model: "), "1")
        self.assertEqual(ui.prompt(), "/exit")

        self.assertEqual(len(created_sessions), 2)
        self.assertFalse(created_sessions[0]["multiline"])
        self.assertTrue(created_sessions[1]["multiline"])
        self.assertTrue(created_sessions[1]["show_frame"])
        self.assertIn("❯", str(created_sessions[1]["message"]()))

    def test_real_prompt_tab_accepts_first_slash_completion(self):
        registry = CommandRegistry(
            [CommandSpec("/help", "show help", "/help")]
        )
        with create_pipe_input() as pipe:
            ui = TerminalUI(
                console=Console(file=io.StringIO(), force_terminal=False),
                command_registry=registry,
                session_factory=lambda **options: PromptSession(
                    input=pipe,
                    output=DummyOutput(),
                    **options,
                ),
            )
            result = []
            errors = []

            def prompt() -> None:
                try:
                    result.append(ui.prompt())
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(target=prompt)
            worker.start()
            time.sleep(0.05)
            pipe.send_text("/")
            deadline = time.monotonic() + 1
            while (
                ui._session is None
                or ui._session.default_buffer.complete_state is None
            ) and time.monotonic() < deadline:
                time.sleep(0.01)
            pipe.send_bytes(b"\t\r")
            worker.join(1)

        self.assertFalse(errors)
        self.assertEqual(result, ["/help"])

    def test_tool_call_hides_stdout_but_keeps_stderr_in_result_card(self):
        stream = io.StringIO()
        ui = TerminalUI(
            console=Console(
                file=stream,
                color_system=None,
                force_terminal=False,
                width=100,
            )
        )

        ui.show_tool(
            "bash",
            {"command": "python -m unittest"},
            {
                "ok": True,
                "exit_code": 0,
                "stdout": "24 tests passed",
                "stderr": "test warning",
            },
        )

        rendered = stream.getvalue()
        self.assertIn("● bash", rendered)
        self.assertIn("python -m unittest", rendered)
        self.assertIn("exit 0", rendered)
        self.assertNotIn("24 tests passed", rendered)
        self.assertIn("test warning", rendered)

    def test_event_sinks_hide_stdout_but_render_stderr_and_status(self):
        base = {
            "source": "tool",
            "session_id": "session-1",
            "task_id": "task-1",
            "correlation_id": "call-1",
            "sequence": 1,
        }
        events = [
            {**base, "kind": "tool.started", "payload": {"name": "bash"}},
            {
                **base,
                "kind": "tool.output_delta",
                "payload": {"stream": "stdout", "text": "very long output"},
            },
            {
                **base,
                "kind": "tool.output_delta",
                "payload": {"stream": "stderr", "text": "warning\n"},
            },
            {
                **base,
                "kind": "tool.finished",
                "payload": {"status": "completed", "exit_code": 0},
            },
        ]

        plain_output = []
        plain = PlainEventSink(plain_output.append)
        for event in events:
            plain.publish_event(event)
        plain.flush()
        plain.stop()

        stream = io.StringIO()
        ui = TerminalUI(
            console=Console(
                file=stream,
                color_system=None,
                force_terminal=False,
                width=100,
            )
        )
        for event in events:
            ui.publish_event(event)
        ui.flush_event_renderer()
        ui.stop_event_renderer()

        plain_rendered = "\n".join(plain_output)
        terminal_rendered = stream.getvalue()
        for rendered in (plain_rendered, terminal_rendered):
            self.assertNotIn("very long output", rendered)
            self.assertIn("warning", rendered)
            self.assertIn("completed", rendered)

    def test_welcome_panel_shows_session_context(self):
        stream = io.StringIO()
        ui = TerminalUI(
            console=Console(
                file=stream,
                color_system=None,
                force_terminal=False,
                width=100,
            ),
            project_root=Path("/tmp/demo"),
            provider="deepseek",
            model="deepseek-v4-pro",
            dashboard_url="http://127.0.0.1:8765/",
        )

        ui.show_welcome()

        rendered = stream.getvalue()
        self.assertIn("laoHuangCode", rendered)
        self.assertIn("/tmp/demo", rendered)
        self.assertIn("deepseek/deepseek-v4-pro", rendered)
        self.assertIn("http://127.0.0.1:8765/", rendered)


if __name__ == "__main__":
    unittest.main()
