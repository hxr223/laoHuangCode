import unittest

from laohuangcode.credentials import resolve_api_key
from laohuangcode.providers import get_provider


class CredentialTests(unittest.TestCase):
    def test_provider_specific_environment_variable_supplies_api_key(self):
        key = resolve_api_key(
            get_provider("deepseek"),
            {"DEEPSEEK_API_KEY": "deepseek-secret"},
        )

        self.assertEqual(key, "deepseek-secret")


if __name__ == "__main__":
    unittest.main()
