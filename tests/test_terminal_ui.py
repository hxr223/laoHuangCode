import io
from pathlib import Path
import unittest

from rich.console import Console

from laohuangcode.terminal_ui import TerminalUI


class TerminalUITests(unittest.TestCase):
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

        class FakeSession:
            def prompt(self):
                return "first line\nsecond line"

        def session_factory(**kwargs):
            options.update(kwargs)
            return FakeSession()

        ui = TerminalUI(
            console=Console(file=io.StringIO(), force_terminal=False),
            session_factory=session_factory,
        )

        value = ui.prompt()

        self.assertEqual(value, "first line\nsecond line")
        self.assertTrue(options["multiline"])
        self.assertTrue(options["enable_history_search"])
        self.assertIn("❯", str(options["message"]))
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
        self.assertIn("❯", str(created_sessions[1]["message"]))

    def test_tool_call_is_rendered_as_a_compact_result_card(self):
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
                "stderr": "",
            },
        )

        rendered = stream.getvalue()
        self.assertIn("● bash", rendered)
        self.assertIn("python -m unittest", rendered)
        self.assertIn("exit 0", rendered)
        self.assertIn("24 tests passed", rendered)

    def test_permission_prompt_hides_file_content(self):
        stream = io.StringIO()

        class FakeSession:
            def prompt(self, **kwargs):
                return "a"

        ui = TerminalUI(
            console=Console(
                file=stream,
                color_system=None,
                force_terminal=False,
                width=100,
            ),
            session_factory=lambda **_kwargs: FakeSession(),
        )

        answer = ui.ask_permission(
            "write", {"path": "notes.txt", "content": "secret"}
        )

        rendered = stream.getvalue()
        self.assertEqual(answer, "a")
        self.assertIn("write", rendered)
        self.assertIn("notes.txt", rendered)
        self.assertNotIn("secret", rendered)
        self.assertIn("6 chars", rendered)

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
        self.assertIn("deepseek / deepseek-v4-pro", rendered)
        self.assertIn("http://127.0.0.1:8765/", rendered)


if __name__ == "__main__":
    unittest.main()
