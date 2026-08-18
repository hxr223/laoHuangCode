import os
import unittest
from unittest.mock import patch

from laohuangcode.config import Config


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


if __name__ == "__main__":
    unittest.main()
