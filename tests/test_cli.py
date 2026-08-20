from contextlib import nullcontext
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
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

    def test_persistent_terminal_repl_exits_without_leaving_its_queue_blocked(self):
        class PersistentUI:
            command_registry = None

            def __init__(self):
                self.messages = []
                self.exit_requests = 0
                self.render_error = None

            def start_event_renderer(self):
                return None

            def show_welcome(self):
                self.messages.append("welcome")

            def run(self, submit):
                submit("/exit")
                time.sleep(0.05)

            def request_exit(self):
                self.exit_requests += 1

            def flush_event_renderer(self):
                return None

            def stop_event_renderer(self):
                return None

            def close(self):
                self.messages.append("closed")

            def show_goodbye(self):
                self.messages.append("goodbye")

            def show_error(self, message):
                self.messages.append(message)

        ui = PersistentUI()
        session = AgentSession(lambda _content: "unused")

        self.assertTrue(run_session_repl(session, ui=ui))
        self.assertEqual(ui.exit_requests, 1)
        self.assertIn("closed", ui.messages)

    def test_persistent_repl_sends_two_inputs_then_exits_cleanly(self):
        class FakePiLoopUI:
            command_registry = None
            render_error = None

            def __init__(self):
                self.closed = False

            def show_welcome(self):
                return None

            def run(self, submit):
                for text in ("first", "second", "/exit"):
                    submit(text)

            def request_exit(self):
                return None

            def flush_event_renderer(self):
                return None

            def close(self):
                self.closed = True

            def show_error(self, message):
                raise AssertionError(message)

            def show_goodbye(self):
                return None

        session = AgentSession(lambda _content: "done")
        ui = FakePiLoopUI()

        clean = run_session_repl(session, ui=ui)

        self.assertTrue(clean)
        self.assertTrue(ui.closed)

    def test_persistent_repl_returns_false_for_terminal_write_failure(self):
        class FakePiLoopUI:
            command_registry = None
            render_error = BrokenPipeError("closed")

            def show_welcome(self):
                return None

            def run(self, submit):
                return None

            def flush_event_renderer(self):
                return None

            def close(self):
                return None

            def show_goodbye(self):
                raise AssertionError("goodbye should not render on loop failure")

            def show_error(self, _message):
                return None

        session = AgentSession(lambda _content: "done")

        self.assertFalse(run_session_repl(session, ui=FakePiLoopUI()))

    def test_persistent_exit_does_not_wait_for_slow_prior_routing(self):
        class FakeSession:
            def __init__(self):
                self.started = threading.Event()
                self.release = threading.Event()
                self.event_bus = SimpleNamespace(flush=lambda: None)
                self.closed = False

            def submit_input(self, text):
                if text == "slow":
                    self.started.set()
                    self.release.wait(5)
                    if self.closed:
                        raise RuntimeError("event bus is closed")
                return SimpleNamespace(
                    task_id="task-1",
                    queued=False,
                    rejected=False,
                    reason="",
                )

            def close(self, *, wait=True, timeout=None):
                del wait, timeout
                self.closed = True
                self.release.set()
                return True

            def queue_status(self):
                return {"pending": 0, "held": 0}

            def publish_notice(self, *_args, **_kwargs):
                if self.closed:
                    raise RuntimeError("event bus is closed")
                return None

        class FakePiLoopUI:
            command_registry = None
            render_error = None

            def __init__(self):
                self.messages = []

            def run(self, submit):
                submit("slow")
                if not session.started.wait(1):
                    raise AssertionError("slow route did not start")
                submit("/exit")

            def show_welcome(self):
                return None

            def request_exit(self):
                return None

            def flush_event_renderer(self):
                return None

            def close(self):
                return None

            def show_error(self, message):
                self.messages.append(message)

        session = FakeSession()
        ui = FakePiLoopUI()
        result = []
        worker = threading.Thread(
            target=lambda: result.append(run_session_repl(session, ui=ui))
        )

        worker.start()
        worker.join(0.5)
        closed_before_cleanup = session.closed
        if worker.is_alive():
            session.release.set()
            worker.join(1)
        session.release.set()

        self.assertFalse(worker.is_alive())
        self.assertEqual(result, [False])
        self.assertTrue(closed_before_cleanup)
        self.assertTrue(session.closed)
        self.assertEqual(
            ui.messages,
            ["Input coordinator failed during shutdown."],
        )

    def test_persistent_repl_reports_unclean_shutdown_before_ui_close(self):
        events = []

        class FakeSession:
            event_bus = SimpleNamespace(flush=lambda: None)

            def close(self, *, wait=True, timeout=None):
                del wait, timeout
                return False

        class FakePiLoopUI:
            command_registry = None
            render_error = None

            def run(self, _submit):
                return None

            def show_welcome(self):
                return None

            def close(self):
                events.append("close")

            def show_error(self, message):
                events.append(f"error:{message}")

        clean = run_session_repl(FakeSession(), ui=FakePiLoopUI())

        self.assertFalse(clean)
        self.assertEqual(
            events,
            ["error:Task worker did not stop before the shutdown timeout.", "close"],
        )

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
