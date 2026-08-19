import unittest

from laohuangcode.providers import get_provider, provider_names


class ProviderTests(unittest.TestCase):
    def test_deepseek_profile_has_working_agent_defaults(self):
        provider = get_provider("deepseek")

        self.assertEqual(provider.default_model, "deepseek-v4-flash")
        self.assertEqual(provider.base_url, "https://api.deepseek.com")
        self.assertEqual(
            provider.suggested_models,
            ("deepseek-v4-flash", "deepseek-v4-pro"),
        )

    def test_supported_provider_names_are_available_for_configuration(self):
        self.assertEqual(provider_names(), ("deepseek", "openai"))
        self.assertIsNone(get_provider("openai").default_model)

        with self.assertRaisesRegex(ValueError, "Unknown provider"):
            get_provider("custom")


if __name__ == "__main__":
    unittest.main()
