from contextlib import redirect_stderr
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from laohuangcode.__main__ import main, run_repl
from laohuangcode.cli import main as cli_main
from laohuangcode.config import ConfigManager


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

    def test_config_command_saves_a_provider_profile_without_starting_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
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
                output_fn=outputs.append,
            )

            self.assertEqual(status, 0)
            self.assertTrue(config_path.exists())
            self.assertTrue(any("work" in output for output in outputs))

    def test_config_command_reports_invalid_interactive_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            errors = io.StringIO()
            with redirect_stderr(errors):
                status = cli_main(
                    ["config"],
                    environ={},
                    config_path=Path(directory) / "config.json",
                    input_fn=lambda _prompt: "invalid-provider",
                )

            self.assertEqual(status, 2)
            self.assertIn("Unknown provider", errors.getvalue())

    def test_configured_deepseek_profile_starts_interactive_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            ConfigManager(config_path).configure(
                name="deepseek", provider="deepseek"
            )
            project_root = Path(__file__).resolve().parents[1]
            environment = os.environ.copy()
            environment.update(
                {
                    "DEEPSEEK_API_KEY": "test-key",
                    "LAOHUANG_CONFIG": str(config_path),
                    "PYTHONPATH": str(project_root / "src"),
                }
            )
            environment.pop("OPENAI_API_KEY", None)
            environment.pop("OPENAI_MODEL", None)

            completed = subprocess.run(
                [sys.executable, "-m", "laohuangcode"],
                cwd=project_root,
                env=environment,
                input="/exit\n",
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn("laoHuangCode is ready", completed.stdout)

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
            ConfigManager(config_path).configure(
                name="deepseek", provider="deepseek"
            )
            outputs = []

            status = cli_main(
                ["doctor"],
                environ={"DEEPSEEK_API_KEY": "secret"},
                config_path=config_path,
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
        self.assertEqual(completed.stdout.strip(), "laohuang 0.2.0")


if __name__ == "__main__":
    unittest.main()
