import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from laohuangcode.credentials import CredentialStore
from laohuangcode.model_selection import ModelSelector


class ModelSelectorTests(unittest.TestCase):
    def test_deepseek_key_and_model_are_selected_in_the_terminal(self):
        with tempfile.TemporaryDirectory() as directory:
            credentials = CredentialStore(Path(directory) / "credentials.json")
            prompts = []
            outputs = []
            selector = ModelSelector(
                credentials=credentials,
                input_fn=lambda prompt: prompts.append(prompt) or "2",
                secret_input_fn=lambda prompt: prompts.append(prompt)
                or "deepseek-secret",
                output_fn=outputs.append,
            )

            selection = selector.select(provider_name="deepseek")

            self.assertIsNotNone(selection)
            self.assertEqual(selection.config.provider, "deepseek")
            self.assertEqual(selection.config.model, "deepseek-v4-pro")
            self.assertEqual(credentials.get("deepseek"), "deepseek-secret")
            self.assertTrue(any("deepseek-v4-pro" in output for output in outputs))
            self.assertNotIn("deepseek-secret", "\n".join(outputs))

    def test_openai_models_are_loaded_before_the_user_selects_one(self):
        with tempfile.TemporaryDirectory() as directory:
            credentials = CredentialStore(Path(directory) / "credentials.json")
            fake_client = SimpleNamespace(
                models=SimpleNamespace(
                    list=lambda: [
                        SimpleNamespace(id="gpt-z"),
                        SimpleNamespace(id="gpt-a"),
                    ]
                )
            )
            outputs = []
            selector = ModelSelector(
                credentials=credentials,
                input_fn=lambda _prompt: "2",
                secret_input_fn=lambda _prompt: "openai-secret",
                output_fn=outputs.append,
                client_factory=lambda **_options: fake_client,
            )

            selection = selector.select(provider_name="openai")

            self.assertIsNotNone(selection)
            self.assertEqual(selection.config.model, "gpt-z")
            self.assertTrue(any("gpt-a" in output for output in outputs))
            self.assertTrue(any("gpt-z" in output for output in outputs))

    def test_user_can_choose_a_provider_before_choosing_the_model(self):
        with tempfile.TemporaryDirectory() as directory:
            credentials = CredentialStore(Path(directory) / "credentials.json")
            credentials.set("deepseek", "saved-secret")
            answers = iter(["1", "1"])
            outputs = []
            selector = ModelSelector(
                credentials=credentials,
                input_fn=lambda _prompt: next(answers),
                secret_input_fn=lambda _prompt: self.fail(
                    "saved credential should be reused"
                ),
                output_fn=outputs.append,
                client_factory=lambda **_options: SimpleNamespace(),
            )

            selection = selector.select()

            self.assertIsNotNone(selection)
            self.assertEqual(selection.config.provider, "deepseek")
            self.assertTrue(any("DeepSeek" in output for output in outputs))
            self.assertTrue(any("OpenAI" in output for output in outputs))

    def test_session_model_selection_requires_a_prior_login(self):
        with tempfile.TemporaryDirectory() as directory:
            outputs = []
            selector = ModelSelector(
                credentials=CredentialStore(Path(directory) / "credentials.json"),
                input_fn=lambda _prompt: self.fail("no model input expected"),
                secret_input_fn=lambda _prompt: self.fail("no key input expected"),
                output_fn=outputs.append,
            )

            selection = selector.select(
                provider_name="deepseek",
                prompt_for_missing_key=False,
            )

            self.assertIsNone(selection)
            self.assertEqual(
                outputs,
                ["No credentials configured for deepseek. Run /login deepseek first."],
            )


if __name__ == "__main__":
    unittest.main()
