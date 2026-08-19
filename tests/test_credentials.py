import stat
import tempfile
from pathlib import Path
import unittest

from laohuangcode.credentials import CredentialStore


class CredentialStoreTests(unittest.TestCase):
    def test_api_key_is_persisted_in_a_private_credentials_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "laohuang" / "credentials.json"

            CredentialStore(path).set("deepseek", "secret-key")

            self.assertEqual(CredentialStore(path).get("deepseek"), "secret-key")
            mode = stat.S_IMODE(path.stat().st_mode)
            self.assertEqual(mode, 0o600)

    def test_user_can_list_and_remove_provider_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            store = CredentialStore(Path(directory) / "credentials.json")
            store.set("deepseek", "deepseek-key")
            store.set("openai", "openai-key")

            removed = store.remove("deepseek")

            self.assertTrue(removed)
            self.assertEqual(store.providers(), ("openai",))
            self.assertIsNone(store.get("deepseek"))
            self.assertFalse(store.remove("deepseek"))


if __name__ == "__main__":
    unittest.main()
