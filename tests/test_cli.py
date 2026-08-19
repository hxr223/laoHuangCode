from contextlib import nullcontext
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest

from laohuangcode.__main__ import run_repl
from laohuangcode import __version__
from laohuangcode.cli import (
    _supports_terminal_ui,
    main as cli_main,
    run_plain_session_repl,
    run_session_repl,
)
from laohuangcode.config import ConfigManager
from laohuangcode.credentials import CredentialStore
from laohuangcode.events import EventProjector
from laohuangcode.session import AgentSession
from laohuangcode.terminal_ui import PlainEventSink


class ReplTests(unittest.TestCase):
    def test_session_repl_keeps_prompting_while_worker_runs(self):
        started = []
        release = threading.Event()

        def runner(text, _context):
            started.append(text)
            release.wait(1)
            return "done"

        session = AgentSession(runner)

        class FakeUI:
            command_registry = None

            def __init__(self):
                self.inputs = iter(["first", "second", "/exit"])
                self.messages = []

            def show_welcome(self):
                self.messages.append("welcome")

            def prompt(self):
                value = next(self.inputs)
                if value == "/exit":
                    release.set()
                return value

            def write(self, message):
                self.messages.append(message)

            def show_error(self, message):
                self.messages.append(message)

            def show_goodbye(self):
                self.messages.append("goodbye")

            def show_interrupted(self):
                self.messages.append("interrupted")

            def stop_event_renderer(self):
                return None

        ui = FakeUI()
        session.event_bus.subscribe(
            lambda event: ui.messages.append(str(event.payload.get("text", "")))
            if event.kind.value == "ui.message"
            else None
        )

        run_session_repl(session, ui=ui)

        self.assertEqual(started[0], "first")
        self.assertTrue(any("Message queued" in item for item in ui.messages))
        self.assertIn("goodbye", ui.messages)

    def test_plain_repl_uses_agent_session_and_waits_for_pipe_eof(self):
        calls = []
        answers = iter(["hello"])
        outputs = []

        def read_input(_prompt):
            try:
                return next(answers)
            except StopIteration as error:
                raise EOFError from error

        session = AgentSession(lambda content: calls.append(content) or "done")
        sink = PlainEventSink(outputs.append)
        projector = EventProjector()
        session.event_bus.subscribe(
            lambda event: sink.publish_event(
                projector.project(event, "terminal")
            )
        )

        run_plain_session_repl(session, input_fn=read_input, sink=sink)

        self.assertEqual(calls, ["hello"])
        self.assertTrue(any("ready" in output for output in outputs))
        self.assertEqual(outputs[-1], "Goodbye.")

    def test_terminal_ui_is_only_enabled_for_the_real_interactive_streams(self):
        tty = SimpleNamespace(isatty=lambda: True)
        pipe = SimpleNamespace(isatty=lambda: False)

        self.assertTrue(
            _supports_terminal_ui(
                input_fn=input,
                output_fn=print,
                stdin=tty,
                stdout=tty,
            )
        )
        self.assertFalse(
            _supports_terminal_ui(
                input_fn=lambda _prompt: "",
                output_fn=print,
                stdin=tty,
                stdout=tty,
            )
        )
        self.assertFalse(
            _supports_terminal_ui(
                input_fn=input,
                output_fn=print,
                stdin=pipe,
                stdout=tty,
            )
        )

    def test_user_can_chat_until_exit(self):
        inputs = iter(["hello", "/exit"])
        outputs = []
        agent = SimpleNamespace(
            inputs=[],
            run=lambda text: agent.inputs.append(text) or "hi there",
        )

        run_repl(
            agent,
            input_fn=lambda prompt: next(inputs),
            output_fn=outputs.append,
        )

        self.assertEqual(agent.inputs, ["hello"])
        self.assertTrue(any("hi there" in output for output in outputs))

    def test_repl_can_drive_a_structured_terminal_ui(self):
        class FakeUI:
            def __init__(self):
                self.inputs = iter(["hello", "/exit"])
                self.events = []

            def show_welcome(self):
                self.events.append("welcome")

            def prompt(self):
                return next(self.inputs)

            def thinking(self):
                return nullcontext()

            def show_assistant(self, response):
                self.events.append(("assistant", response))

            def show_goodbye(self):
                self.events.append("goodbye")

        ui = FakeUI()
        agent = SimpleNamespace(run=lambda _text: "hi there")

        run_repl(agent, ui=ui)

        self.assertEqual(
            ui.events,
            ["welcome", ("assistant", "hi there"), "goodbye"],
        )

    def test_first_start_collects_provider_key_and_model_in_the_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            credentials_path = Path(directory) / "credentials.json"
            answers = iter(["1", "1", "/exit"])
            outputs = []

            status = cli_main(
                [],
                environ={},
                config_path=config_path,
                credentials_path=credentials_path,
                input_fn=lambda _prompt: next(answers),
                secret_input_fn=lambda _prompt: "terminal-secret",
                output_fn=outputs.append,
                client_factory=lambda **_options: SimpleNamespace(),
            )

            self.assertEqual(status, 0)
            self.assertEqual(
                CredentialStore(credentials_path).get("deepseek"),
                "terminal-secret",
            )
            self.assertNotIn("terminal-secret", "\n".join(outputs))
            self.assertEqual(
                ConfigManager(config_path).list_profiles()[0]["model"],
                "deepseek-v4-flash",
            )

    def test_web_flag_starts_dashboard_and_cleanly_exits(self):
        project_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            ConfigManager(config_path).configure(
                name="default", provider="deepseek"
            )
            CredentialStore(config_path.with_name("credentials.json")).set(
                "deepseek", "test-key"
            )
            environment = os.environ.copy()
            environment.update(
                {
                    "LAOHUANG_CONFIG": str(config_path),
                    "PYTHONPATH": str(project_root / "src"),
                }
            )

            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "laohuangcode",
                    "--web",
                    "--web-port",
                    "0",
                ],
                cwd=project_root,
                env=environment,
                input="/exit\n",
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("Web dashboard: http://127.0.0.1:", completed.stdout)

    def test_config_command_saves_a_provider_profile_without_starting_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            credentials_path = Path(directory) / "credentials.json"
            outputs = []

            status = cli_main(
                [
                    "config",
                    "--profile",
                    "work",
                    "--provider",
                    "deepseek",
                ],
                environ={},
                config_path=config_path,
                credentials_path=credentials_path,
                input_fn=lambda _prompt: "1",
                secret_input_fn=lambda _prompt: "terminal-key",
                output_fn=outputs.append,
                client_factory=lambda **_options: SimpleNamespace(),
            )

            self.assertEqual(status, 0)
            self.assertTrue(config_path.exists())
            self.assertEqual(
                CredentialStore(credentials_path).get("deepseek"),
                "terminal-key",
            )
            self.assertTrue(any("work" in output for output in outputs))

    def test_config_command_reports_invalid_interactive_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs = []
            status = cli_main(
                ["config"],
                environ={},
                config_path=Path(directory) / "config.json",
                input_fn=lambda _prompt: "invalid-provider",
                secret_input_fn=lambda _prompt: self.fail("no key expected"),
                output_fn=outputs.append,
            )

            self.assertEqual(status, 2)
            self.assertTrue(any("invalid provider" in line for line in outputs))

    def test_configured_deepseek_profile_starts_interactive_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            credentials_path = Path(directory) / "credentials.json"
            ConfigManager(config_path).configure(
                name="deepseek", provider="deepseek"
            )
            outputs = []

            status = cli_main(
                [],
                environ={},
                config_path=config_path,
                credentials_path=credentials_path,
                input_fn=lambda _prompt: "/exit",
                secret_input_fn=lambda _prompt: "terminal-key",
                output_fn=outputs.append,
                client_factory=lambda **_options: SimpleNamespace(),
            )

            self.assertEqual(status, 0)
            self.assertEqual(
                CredentialStore(credentials_path).get("deepseek"),
                "terminal-key",
            )
            self.assertTrue(
                any("laoHuangCode is ready" in output for output in outputs)
            )

    def test_user_can_list_profiles_and_switch_the_active_one(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            manager = ConfigManager(config_path)
            manager.configure(name="flash", provider="deepseek")
            manager.configure(
                name="pro",
                provider="deepseek",
                model="deepseek-v4-pro",
            )
            outputs = []

            use_status = cli_main(
                ["config", "use", "flash"],
                environ={},
                config_path=config_path,
                output_fn=outputs.append,
            )
            list_status = cli_main(
                ["config", "list"],
                environ={},
                config_path=config_path,
                output_fn=outputs.append,
            )

            self.assertEqual((use_status, list_status), (0, 0))
            self.assertTrue(any("* flash" in output for output in outputs))
            self.assertTrue(any("deepseek-v4-pro" in output for output in outputs))

    def test_doctor_reports_resolved_runtime_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            credentials_path = Path(directory) / "credentials.json"
            ConfigManager(config_path).configure(
                name="deepseek", provider="deepseek"
            )
            CredentialStore(credentials_path).set("deepseek", "secret")
            outputs = []

            status = cli_main(
                ["doctor"],
                environ={},
                config_path=config_path,
                credentials_path=credentials_path,
                output_fn=outputs.append,
            )

            self.assertEqual(status, 0)
            report = "\n".join(outputs)
            self.assertIn("Provider: deepseek", report)
            self.assertIn("Model: deepseek-v4-flash", report)
            self.assertIn("API key: configured", report)

    def test_version_flag_works_without_model_configuration(self):
        project_root = Path(__file__).resolve().parents[1]
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(project_root / "src")

        completed = subprocess.run(
            [sys.executable, "-m", "laohuangcode", "--version"],
            cwd=project_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), f"laohuang {__version__}")


if __name__ == "__main__":
    unittest.main()
