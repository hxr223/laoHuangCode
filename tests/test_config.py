import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from laohuangcode.config import Config, ConfigManager


class ConfigTests(unittest.TestCase):
    def test_loads_openai_compatible_settings_from_environment(self):
        env = {
            "OPENAI_API_KEY": "test-key",
            "OPENAI_MODEL": "test-model",
            "OPENAI_BASE_URL": "https://example.test/v1",
        }

        with patch.dict(os.environ, env, clear=True):
            config = Config.from_env()

        self.assertEqual(config.api_key, "test-key")
        self.assertEqual(config.model, "test-model")
        self.assertEqual(config.base_url, "https://example.test/v1")

    def test_reports_all_missing_required_settings(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(
                ValueError, "OPENAI_API_KEY, OPENAI_MODEL"
            ):
                Config.from_env()

    def test_user_can_save_and_resolve_a_deepseek_profile_without_storing_key(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            manager = ConfigManager(config_path)

            manager.configure(name="deepseek", provider="deepseek")
            config = manager.resolve(
                environ={"DEEPSEEK_API_KEY": "deepseek-secret"}
            )

            self.assertEqual(config.provider, "deepseek")
            self.assertEqual(config.model, "deepseek-v4-flash")
            self.assertEqual(config.base_url, "https://api.deepseek.com")
            self.assertEqual(config.api_key, "deepseek-secret")
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertNotIn("deepseek-secret", json.dumps(persisted))

    def test_runtime_overrides_follow_cli_environment_file_priority(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = ConfigManager(Path(directory) / "config.json")
            manager.configure(
                name="customized",
                provider="deepseek",
                model="file-model",
                base_url="https://file.example/v1",
            )
            environment = {
                "DEEPSEEK_API_KEY": "secret",
                "LAOHUANG_MODEL": "environment-model",
                "LAOHUANG_BASE_URL": "https://environment.example/v1",
            }

            from_environment = manager.resolve(environ=environment)
            from_cli = manager.resolve(
                environ=environment,
                model="cli-model",
                base_url="https://cli.example/v1",
            )

            self.assertEqual(from_environment.model, "environment-model")
            self.assertEqual(
                from_environment.base_url, "https://environment.example/v1"
            )
            self.assertEqual(from_cli.model, "cli-model")
            self.assertEqual(from_cli.base_url, "https://cli.example/v1")

    def test_malformed_profile_document_has_an_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            config_path.write_text('{"profiles": []}\n', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "profiles must be an object"):
                ConfigManager(config_path).list_profiles()


if __name__ == "__main__":
    unittest.main()
