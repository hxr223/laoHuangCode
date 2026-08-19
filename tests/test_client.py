from types import SimpleNamespace
import unittest

from laohuangcode.client import create_client
from laohuangcode.config import Config


class ClientTests(unittest.TestCase):
    def test_openai_compatible_client_receives_resolved_connection_settings(self):
        calls = []

        def client_factory(**options):
            calls.append(options)
            return SimpleNamespace(options=options)

        config = Config(
            api_key="secret",
            model="deepseek-v4-flash",
            base_url="https://api.deepseek.com",
            provider="deepseek",
        )

        client = create_client(config, client_factory=client_factory)

        self.assertEqual(client.options["api_key"], "secret")
        self.assertEqual(client.options["base_url"], "https://api.deepseek.com")
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
