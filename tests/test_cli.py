from contextlib import redirect_stderr
import io
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from laohuangcode.__main__ import main, run_repl


class ReplTests(unittest.TestCase):
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

    def test_startup_explains_missing_configuration(self):
        errors = io.StringIO()

        with patch.dict(os.environ, {}, clear=True), redirect_stderr(errors):
            status = main([])

        self.assertEqual(status, 2)
        self.assertIn("OPENAI_API_KEY, OPENAI_MODEL", errors.getvalue())

    def test_web_flag_starts_dashboard_and_cleanly_exits(self):
        project_root = Path(__file__).resolve().parents[1]
        environment = os.environ.copy()
        environment.update(
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_MODEL": "test-model",
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


if __name__ == "__main__":
    unittest.main()
