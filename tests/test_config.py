import json
from pathlib import Path
import tempfile
import unittest

from laohuangcode.config import ConfigManager
from laohuangcode.credentials import CredentialStore


class ConfigTests(unittest.TestCase):
    def test_missing_provider_api_key_has_an_actionable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = ConfigManager(Path(directory) / "config.json")
            manager.configure(name="default", provider="deepseek")

            with self.assertRaisesRegex(ValueError, "No API key configured"):
                manager.resolve(
                    credentials=CredentialStore(
                        Path(directory) / "credentials.json"
                    )
                )

    def test_openai_profile_requires_an_explicit_model(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = ConfigManager(Path(directory) / "config.json")

            with self.assertRaisesRegex(ValueError, "model is required"):
                manager.configure(name="openai", provider="openai")

    def test_user_can_save_and_resolve_a_deepseek_profile_without_storing_key(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            manager = ConfigManager(config_path)
            credentials = CredentialStore(Path(directory) / "credentials.json")

            manager.configure(name="deepseek", provider="deepseek")
            credentials.set("deepseek", "deepseek-secret")
            config = manager.resolve(credentials=credentials)

            self.assertEqual(config.provider, "deepseek")
            self.assertEqual(config.model, "deepseek-v4-flash")
            self.assertEqual(config.base_url, "https://api.deepseek.com")
            self.assertEqual(config.api_key, "deepseek-secret")
            persisted = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertNotIn("deepseek-secret", json.dumps(persisted))

    def test_runtime_overrides_take_priority_over_saved_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = ConfigManager(Path(directory) / "config.json")
            credentials = CredentialStore(Path(directory) / "credentials.json")
            manager.configure(
                name="customized",
                provider="deepseek",
                model="file-model",
                base_url="https://file.example/v1",
            )
            credentials.set("deepseek", "secret")
            from_cli = manager.resolve(
                credentials=credentials,
                model="cli-model",
                base_url="https://cli.example/v1",
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
