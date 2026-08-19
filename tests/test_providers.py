import unittest

from laohuangcode.providers import get_provider, provider_names


class ProviderTests(unittest.TestCase):
    def test_deepseek_profile_has_working_agent_defaults(self):
        provider = get_provider("deepseek")

        self.assertEqual(provider.default_model, "deepseek-v4-flash")
        self.assertEqual(provider.base_url, "https://api.deepseek.com")
        self.assertEqual(provider.api_key_env, "DEEPSEEK_API_KEY")

    def test_supported_provider_names_are_available_for_configuration(self):
        self.assertEqual(provider_names(), ("custom", "deepseek", "openai"))
        self.assertEqual(get_provider("openai").api_key_env, "OPENAI_API_KEY")
        self.assertIsNone(get_provider("custom").default_model)


if __name__ == "__main__":
    unittest.main()
