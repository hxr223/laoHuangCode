import os
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import patch

from laohuangcode.bash_runner import ToolExecutionContext, run_bash
from laohuangcode.cancellation import CancelToken
from laohuangcode.events import EventBus, EventKind


class BashRunnerTests(unittest.TestCase):
    def test_streams_stdout_and_stderr_as_separate_events(self):
        with tempfile.TemporaryDirectory() as directory:
            events = EventBus()
            context = ToolExecutionContext(
                session_id="session-1",
                task_id="task-1",
                tool_call_id="tool-1",
                event_sink=events,
            )

            result = run_bash(
                "printf out; printf err >&2",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=100,
                context=context,
            )

            published = events.drain()
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.stdout, "out")
            self.assertEqual(result.stderr, "err")
            self.assertEqual(published[0].kind, EventKind.TOOL_STARTED)
            self.assertEqual(published[-1].kind, EventKind.TOOL_FINISHED)
            self.assertEqual(
                published[0].payload,
                {"name": "bash", "arguments": {"command": "printf out; printf err >&2"}},
            )
            self.assertIn("duration_ms", published[-1].payload)
            self.assertFalse(published[-1].payload["truncated"])
            deltas = [
                event
                for event in published
                if event.kind is EventKind.TOOL_OUTPUT_DELTA
            ]
            by_stream = {
                stream: "".join(
                    str(event.payload["text"])
                    for event in deltas
                    if event.payload["stream"] == stream
                )
                for stream in ("stdout", "stderr")
            }
            self.assertEqual(by_stream, {"stdout": "out", "stderr": "err"})
            self.assertTrue(
                all(event.correlation_id == "tool-1" for event in published)
            )

    def test_preserves_utf8_split_across_pipe_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_bash(
                "printf '\\344\\275'; sleep 0.01; printf '\\240'",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=100,
            )

            self.assertEqual(result.stdout, "你")

    def test_final_output_keeps_forty_percent_head_and_sixty_percent_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_bash(
                "printf 0123456789ABCDEF",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=10,
            )

            self.assertTrue(result.stdout.startswith("0123\n"))
            self.assertIn("truncated 6 chars", result.stdout)
            self.assertTrue(result.stdout.endswith("ABCDEF"))
            self.assertTrue(result.truncated)
            self.assertGreaterEqual(result.duration_ms, 0)

    def test_nonzero_exit_is_failed(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_bash(
                "printf problem >&2; exit 7",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=100,
            )

            self.assertFalse(result.ok)
            self.assertEqual(result.status, "failed")
            self.assertEqual(result.exit_code, 7)
            self.assertEqual(result.stderr, "problem")

    def test_timeout_terminates_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_bash(
                "sleep 10",
                cwd=Path(directory),
                timeout=0.02,
                max_output_chars=100,
            )

            self.assertFalse(result.ok)
            self.assertEqual(result.status, "timed_out")
            self.assertIn("timed out", result.error or "")

    def test_cancel_token_stops_running_command(self):
        with tempfile.TemporaryDirectory() as directory:
            token = CancelToken()
            before_seen = threading.Event()

            def sink(kind: str, payload: dict) -> None:
                if (
                    kind == "tool.output_delta"
                    and payload.get("stream") == "stdout"
                    and "before" in payload.get("text", "")
                ):
                    before_seen.set()

            context = ToolExecutionContext(cancel_token=token, event_sink=sink)

            def cancel_once_output_starts() -> None:
                # Cancel only after "before" is observable; a fixed delay races
                # with login-shell startup on slow CI runners.
                before_seen.wait(timeout=5)
                token.cancel("user requested")

            canceller = threading.Thread(target=cancel_once_output_starts, daemon=True)
            canceller.start()
            try:
                result = run_bash(
                    "printf before; sleep 10; printf after",
                    cwd=Path(directory),
                    timeout=5,
                    max_output_chars=100,
                    context=context,
                )
            finally:
                canceller.join(timeout=1)

            self.assertEqual(result.status, "cancelled")
            self.assertEqual(result.error, "user requested")
            self.assertIn("before", result.stdout)
            self.assertNotIn("after", result.stdout)

    def test_stdin_is_closed_for_noninteractive_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_bash(
                "if read value; then printf open; else printf closed; fi",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=100,
            )

            self.assertEqual(result.stdout, "closed")

    def test_removes_terminal_control_sequences(self):
        with tempfile.TemporaryDirectory() as directory:
            result = run_bash(
                "printf '\\033[31mred\\033[0m\\033]0;title\\007safe\\b'",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=100,
            )

            self.assertEqual(result.stdout, "redsafe")
            self.assertNotIn("\x1b", result.stdout)

    def test_spawn_error_has_spawn_failed_status(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch(
                "laohuangcode.bash_runner.subprocess.Popen",
                side_effect=OSError("cannot spawn"),
            ):
                result = run_bash(
                    "true",
                    cwd=Path(directory),
                    timeout=2,
                    max_output_chars=100,
                )

            self.assertEqual(result.status, "spawn_failed")
            self.assertIn("cannot spawn", result.error or "")

    def test_removes_model_keys_from_explicit_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = os.environ.copy()
            environment["OPENAI_API_KEY"] = "secret"
            result = run_bash(
                "printf %s \"$OPENAI_API_KEY\"",
                cwd=Path(directory),
                timeout=2,
                max_output_chars=100,
                env=environment,
            )

            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
