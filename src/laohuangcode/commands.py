"""Slash commands available inside an interactive agent session."""

from __future__ import annotations

from collections.abc import Callable
import shlex

from .agent import CodingAgent
from .config import Config
from .credentials import CredentialStore
from .model_selection import ModelSelector
from .providers import get_provider, provider_names


class SessionCommands:
    """Handle session-local model and credential commands."""

    def __init__(
        self,
        *,
        agent: CodingAgent,
        selector: ModelSelector,
        credentials: CredentialStore,
        current_config: Config,
        secret_input_fn: Callable[[str], str],
        output_fn: Callable[[str], None] = print,
    ) -> None:
        self.agent = agent
        self.selector = selector
        self.credentials = credentials
        self.current_config = current_config
        self.secret_input_fn = secret_input_fn
        self.output_fn = output_fn

    def handle(self, command: str) -> bool:
        try:
            parts = shlex.split(command)
        except ValueError as error:
            self.output_fn(f"Invalid command: {error}")
            return True
        if not parts:
            return False

        if parts[0] == "/model":
            return self._handle_model(parts[1:])
        if parts[0] == "/login":
            return self._handle_login(parts[1:])
        if parts[0] == "/logout":
            return self._handle_logout(parts[1:])
        if parts[0] == "/apikey":
            return self._handle_api_key(parts[1:])
        if parts[0] == "/help":
            self.output_fn(
                "Commands: /model, /model current, "
                "/model <provider> [model], /login [provider], "
                "/logout [provider], /exit"
            )
            return True
        return False

    def _handle_model(self, arguments: list[str]) -> bool:
        if arguments == ["current"]:
            self.output_fn(
                f"Current model: {self.current_config.provider} / "
                f"{self.current_config.model}"
            )
            return True
        if len(arguments) > 2:
            self.output_fn("Usage: /model [provider] [model]")
            return True

        provider = arguments[0] if arguments else None
        model = arguments[1] if len(arguments) == 2 else None
        try:
            selection = self.selector.select(
                provider_name=provider,
                model_name=model,
                prompt_for_missing_key=False,
            )
        except ValueError as error:
            self.output_fn(f"Could not switch model: {error}")
            return True
        if selection is None:
            return True
        self.agent.switch_model(
            client=selection.client,
            model=selection.config.model,
            provider=selection.config.provider,
        )
        self.current_config = selection.config
        self.output_fn(
            f"Switched to {selection.config.provider} / {selection.config.model}"
        )
        return True

    def _handle_login(self, arguments: list[str]) -> bool:
        if len(arguments) > 1:
            self.output_fn("Usage: /login [provider]")
            return True
        provider = arguments[0] if arguments else self._choose_provider()
        if provider is None:
            return True
        try:
            get_provider(provider)
        except ValueError as error:
            self.output_fn(str(error))
            return True

        try:
            api_key = self.secret_input_fn(
                f"Enter {provider} API key: "
            ).strip()
        except (EOFError, KeyboardInterrupt):
            self.output_fn("Login cancelled; credentials were not changed.")
            return True
        if not api_key:
            self.output_fn("Login cancelled; credentials were not changed.")
            return True
        self.credentials.set(provider, api_key)
        if self.current_config.provider == provider:
            try:
                selection = self.selector.select(
                    provider_name=provider,
                    model_name=self.current_config.model,
                    prompt_for_missing_key=False,
                )
            except ValueError as error:
                self.output_fn(f"Credentials saved but could not be applied: {error}")
                return True
            if selection is not None:
                self.agent.switch_model(
                    client=selection.client,
                    model=selection.config.model,
                    provider=selection.config.provider,
                )
                self.current_config = selection.config
                self.output_fn(f"Logged in to {provider}; credentials applied.")
                return True
        self.output_fn(f"Logged in to {provider}; use /model to select it.")
        return True

    def _handle_logout(self, arguments: list[str]) -> bool:
        if len(arguments) > 1:
            self.output_fn("Usage: /logout [provider]")
            return True
        provider = arguments[0] if arguments else self._choose_provider()
        if provider is None:
            return True
        try:
            get_provider(provider)
        except ValueError as error:
            self.output_fn(str(error))
            return True
        if self.credentials.remove(provider):
            suffix = (
                " The current client remains active until you switch models or exit."
                if self.current_config.provider == provider
                else ""
            )
            self.output_fn(f"Logged out of {provider}.{suffix}")
        else:
            self.output_fn(f"No credentials stored for {provider}.")
        return True

    def _handle_api_key(self, arguments: list[str]) -> bool:
        """Compatibility alias for the pre-/login credential commands."""
        if not arguments:
            configured = set(self.credentials.providers())
            for provider in provider_names():
                status = "configured" if provider in configured else "not configured"
                self.output_fn(f"{provider}: {status}")
            self.output_fn("Use /login or /logout to manage credentials.")
            return True
        if arguments[0] == "set":
            return self._handle_login(arguments[1:])
        if arguments[0] == "remove":
            return self._handle_logout(arguments[1:])
        self.output_fn("Usage: /apikey [set|remove] [provider]")
        return True

    def _choose_provider(self) -> str | None:
        providers = provider_names()
        for index, provider in enumerate(providers, start=1):
            self.output_fn(f"  {index}. {provider}")
        try:
            answer = self.selector.input_fn("Select provider: ").strip()
        except (EOFError, KeyboardInterrupt):
            self.output_fn("Provider selection cancelled.")
            return None
        try:
            return providers[int(answer) - 1]
        except (IndexError, ValueError):
            self.output_fn("Invalid provider selection.")
            return None
