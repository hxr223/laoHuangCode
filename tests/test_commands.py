import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from laohuangcode.agent import CodingAgent
from laohuangcode.cli import run_repl
from laohuangcode.commands import SessionCommands
from laohuangcode.config import Config
from laohuangcode.credentials import CredentialStore
from laohuangcode.model_selection import ModelSelector
from laohuangcode.tools import ToolRegistry


class SessionCommandTests(unittest.TestCase):
    def test_model_current_reports_the_active_provider_and_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = []
            commands = SessionCommands(
                agent=CodingAgent(
                    client=SimpleNamespace(),
                    model="deepseek-v4-flash",
                    tools=ToolRegistry(root),
                ),
                selector=ModelSelector(
                    credentials=CredentialStore(root / "credentials.json"),
                    input_fn=lambda _prompt: self.fail("no input expected"),
                    secret_input_fn=lambda _prompt: self.fail("no key expected"),
                    output_fn=outputs.append,
                ),
                credentials=CredentialStore(root / "credentials.json"),
                current_config=Config(
                    api_key="hidden",
                    model="deepseek-v4-flash",
                    provider="deepseek",
                ),
                secret_input_fn=lambda _prompt: "unused",
                output_fn=outputs.append,
            )

            handled = commands.handle("/model current")

            self.assertTrue(handled)
            self.assertEqual(outputs, ["Current model: deepseek / deepseek-v4-flash"])

    def test_model_command_switches_provider_and_model_without_chatting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = CredentialStore(root / "credentials.json")
            credentials.set("deepseek", "saved-key")
            replacement_client = SimpleNamespace()
            selector = ModelSelector(
                credentials=credentials,
                input_fn=lambda _prompt: self.fail("no choice should be needed"),
                secret_input_fn=lambda _prompt: self.fail("key is already saved"),
                output_fn=lambda _text: None,
                client_factory=lambda **_options: replacement_client,
            )
            agent = CodingAgent(
                client=SimpleNamespace(),
                model="old-model",
                tools=ToolRegistry(root),
            )
            outputs = []
            commands = SessionCommands(
                agent=agent,
                selector=selector,
                credentials=credentials,
                current_config=Config(
                    api_key="old-key",
                    model="old-model",
                    provider="openai",
                ),
                secret_input_fn=lambda _prompt: "unused",
                output_fn=outputs.append,
            )
            answers = iter(["/model deepseek deepseek-v4-pro", "/exit"])

            run_repl(
                agent,
                command_handler=commands.handle,
                input_fn=lambda _prompt: next(answers),
                output_fn=outputs.append,
            )

            self.assertEqual(agent.model, "deepseek-v4-pro")
            self.assertIs(agent.client, replacement_client)
            self.assertTrue(any("deepseek-v4-pro" in output for output in outputs))

    def test_login_and_logout_manage_saved_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = CredentialStore(root / "credentials.json")
            outputs = []
            replacement_client = SimpleNamespace()
            agent = CodingAgent(
                client=SimpleNamespace(),
                model="deepseek-v4-flash",
                provider="deepseek",
                tools=ToolRegistry(root),
            )
            commands = SessionCommands(
                agent=agent,
                selector=ModelSelector(
                    credentials=credentials,
                    input_fn=lambda _prompt: self.fail("no selection expected"),
                    secret_input_fn=lambda _prompt: self.fail(
                        "command supplies the secret"
                    ),
                    output_fn=outputs.append,
                    client_factory=lambda **_options: replacement_client,
                ),
                credentials=credentials,
                current_config=Config(
                    api_key="old-key",
                    model="deepseek-v4-flash",
                    provider="deepseek",
                ),
                secret_input_fn=lambda _prompt: "new-key",
                output_fn=outputs.append,
            )

            commands.handle("/login deepseek")
            commands.handle("/apikey")
            commands.handle("/logout deepseek")

            self.assertIs(agent.client, replacement_client)
            self.assertIsNone(credentials.get("deepseek"))
            self.assertTrue(any("deepseek: configured" == line for line in outputs))
            self.assertFalse(any("new-key" in line for line in outputs))

    def test_api_key_commands_remain_compatible_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credentials = CredentialStore(root / "credentials.json")
            outputs = []
            commands = SessionCommands(
                agent=CodingAgent(
                    client=SimpleNamespace(),
                    model="deepseek-v4-flash",
                    provider="deepseek",
                    tools=ToolRegistry(root),
                ),
                selector=ModelSelector(
                    credentials=credentials,
                    input_fn=lambda _prompt: self.fail("no selection expected"),
                    secret_input_fn=lambda _prompt: self.fail("no selector key expected"),
                    output_fn=outputs.append,
                    client_factory=lambda **_options: SimpleNamespace(),
                ),
                credentials=credentials,
                current_config=Config(
                    api_key="old-key",
                    model="deepseek-v4-flash",
                    provider="deepseek",
                ),
                secret_input_fn=lambda _prompt: "alias-key",
                output_fn=outputs.append,
            )

            commands.handle("/apikey set deepseek")
            self.assertEqual(credentials.get("deepseek"), "alias-key")

            commands.handle("/apikey remove deepseek")
            self.assertIsNone(credentials.get("deepseek"))

    def test_model_does_not_prompt_for_missing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = []
            commands = SessionCommands(
                agent=CodingAgent(
                    client=SimpleNamespace(),
                    model="deepseek-v4-flash",
                    provider="deepseek",
                    tools=ToolRegistry(root),
                ),
                selector=ModelSelector(
                    credentials=CredentialStore(root / "credentials.json"),
                    input_fn=lambda _prompt: self.fail("no selection expected"),
                    secret_input_fn=lambda _prompt: self.fail("/model must not log in"),
                    output_fn=outputs.append,
                ),
                credentials=CredentialStore(root / "credentials.json"),
                current_config=Config(
                    api_key="old-key",
                    model="deepseek-v4-flash",
                    provider="deepseek",
                ),
                secret_input_fn=lambda _prompt: self.fail("/model must not log in"),
                output_fn=outputs.append,
            )

            commands.handle("/model openai gpt-test")

            self.assertTrue(any("/login openai" in line for line in outputs))


if __name__ == "__main__":
    unittest.main()
