import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from prompt_toolkit.document import Document

from laohuangcode.agent import CodingAgent
from laohuangcode.cli import run_repl
from laohuangcode.commands import CommandCompleter, SessionCommands
from laohuangcode.config import Config
from laohuangcode.credentials import CredentialStore
from laohuangcode.model_selection import ModelSelector
from laohuangcode.tools import ToolRegistry


class SessionCommandTests(unittest.TestCase):
    def _commands(self, root, *, outputs, session=None):
        credentials = CredentialStore(root / "credentials.json")
        return SessionCommands(
            agent=CodingAgent(
                client=SimpleNamespace(),
                model="deepseek-v4-flash",
                provider="deepseek",
                tools=ToolRegistry(root),
            ),
            selector=ModelSelector(
                credentials=credentials,
                input_fn=lambda _prompt: self.fail("no selection expected"),
                secret_input_fn=lambda _prompt: self.fail("no secret expected"),
                output_fn=outputs.append,
            ),
            credentials=credentials,
            current_config=Config(
                api_key="hidden",
                model="deepseek-v4-flash",
                provider="deepseek",
            ),
            secret_input_fn=lambda _prompt: "unused",
            output_fn=outputs.append,
            session=session,
        )

    def test_slash_commands_and_model_arguments_are_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = self._commands(Path(directory), outputs=[])
            completer = CommandCompleter(commands.registry)

            commands_found = list(
                completer.get_completions(Document("/mo"), None)
            )
            models_found = list(
                completer.get_completions(Document("/model deepseek "), None)
            )
            plain_found = list(
                completer.get_completions(Document("please read files"), None)
            )

            self.assertIn("/model", [item.text for item in commands_found])
            self.assertIn(
                "deepseek-v4-flash", [item.text for item in models_found]
            )
            self.assertEqual(plain_found, [])

    def test_running_completion_filters_mutating_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = self._commands(Path(directory), outputs=[])
            completer = CommandCompleter(
                commands.registry, state_fn=lambda: "RUNNING_MODEL"
            )

            commands_found = list(
                completer.get_completions(Document("/"), None)
            )
            model_arguments = list(
                completer.get_completions(Document("/model "), None)
            )

            names = [item.text for item in commands_found]
            self.assertNotIn("/login", names)
            self.assertIn("/cancel", names)
            self.assertIn("/model", names)
            self.assertEqual(
                [item.text for item in model_arguments], ["current"]
            )

    def test_queue_commands_delegate_to_agent_session(self):
        session = SimpleNamespace(
            queue_status=lambda: {"pending": 2, "held": 1},
            clear_queues=lambda: 3,
            resume_held=lambda: 1,
        )
        with tempfile.TemporaryDirectory() as directory:
            outputs = []
            commands = self._commands(
                Path(directory), outputs=outputs, session=session
            )

            commands.handle("/queue")
            commands.handle("/queue resume")
            commands.handle("/queue clear")

            self.assertEqual(
                outputs,
                [
                    "Pending: 2 · Held: 1",
                    "Resumed 1 held message(s).",
                    "Cleared 3 queued message(s).",
                ],
            )

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
