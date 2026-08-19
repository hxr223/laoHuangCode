"""Interactive provider, credential, and model selection."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .client import create_client
from .config import Config
from .credentials import CredentialStore
from .providers import get_provider, provider_names


@dataclass(frozen=True)
class ModelSelection:
    config: Config
    client: Any


class ModelSelector:
    """Build a runtime model selection without exposing API keys."""

    def __init__(
        self,
        *,
        credentials: CredentialStore,
        input_fn: Callable[[str], str] = input,
        secret_input_fn: Callable[[str], str],
        output_fn: Callable[[str], None] = print,
        client_factory: Callable[..., Any] | None = None,
    ) -> None:
        self.credentials = credentials
        self.input_fn = input_fn
        self.secret_input_fn = secret_input_fn
        self.output_fn = output_fn
        self.client_factory = client_factory

    def select(
        self,
        *,
        provider_name: str | None = None,
        model_name: str | None = None,
        prompt_for_missing_key: bool = True,
    ) -> ModelSelection | None:
        if provider_name is None:
            provider_name = self._choose_provider()
            if provider_name is None:
                return None
        provider = get_provider(provider_name)
        api_key = self.credentials.get(provider_name)
        new_api_key = api_key is None
        if api_key is None:
            if not prompt_for_missing_key:
                self.output_fn(
                    f"No credentials configured for {provider_name}. "
                    f"Run /login {provider_name} first."
                )
                return None
            api_key = self._read_secret(f"Enter {provider_name} API key: ")
            if not api_key:
                self.output_fn("Model selection cancelled: API key is empty.")
                return None

        connection_config = Config(
            api_key=api_key,
            model=model_name or provider.default_model or "",
            base_url=provider.base_url,
            provider=provider_name,
        )
        client = create_client(
            connection_config,
            client_factory=self.client_factory,
        )
        if model_name is None:
            models = provider.suggested_models
            if not models:
                try:
                    models = tuple(
                        sorted(
                            model.id
                            for model in client.models.list()
                            if isinstance(getattr(model, "id", None), str)
                        )
                    )
                except Exception as error:
                    self.output_fn(
                        "Could not load models "
                        f"({type(error).__name__}); enter a model name manually."
                    )
                    models = ()
            model_name = (
                self._choose_model(models)
                if models
                else self._read_input("Model name: ") or None
            )
            if model_name is None:
                self.output_fn("Model selection cancelled: model name is empty.")
                return None

        config = Config(
            api_key=api_key,
            model=model_name,
            base_url=provider.base_url,
            provider=provider_name,
        )
        if new_api_key:
            self.credentials.set(provider_name, api_key)
        return ModelSelection(config=config, client=client)

    def _choose_provider(self) -> str | None:
        names = provider_names()
        display_names = {"deepseek": "DeepSeek", "openai": "OpenAI"}
        self.output_fn("Model providers:")
        for index, name in enumerate(names, start=1):
            self.output_fn(f"  {index}. {display_names[name]}")
        answer = self._read_input("Select provider: ")
        if answer is None:
            return None
        try:
            return names[int(answer) - 1]
        except (IndexError, ValueError):
            self.output_fn("Model selection cancelled: invalid provider.")
            return None

    def _choose_model(self, models: tuple[str, ...]) -> str | None:
        self.output_fn("Available models:")
        for index, model in enumerate(models, start=1):
            self.output_fn(f"  {index}. {model}")
        self.output_fn("  m. Enter a model name manually")
        answer = self._read_input("Select model: ")
        if answer is None:
            return None
        if answer.casefold() == "m":
            manual = self._read_input("Model name: ")
            return manual or None
        try:
            return models[int(answer) - 1]
        except (IndexError, ValueError):
            self.output_fn("Model selection cancelled: invalid choice.")
            return None

    def _read_input(self, prompt: str) -> str | None:
        try:
            return self.input_fn(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            self.output_fn("Model selection cancelled.")
            return None

    def _read_secret(self, prompt: str) -> str | None:
        try:
            return self.secret_input_fn(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            self.output_fn("Model selection cancelled.")
            return None
