"""Construct the OpenAI-compatible SDK client from resolved configuration."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .config import Config


def create_client(
    config: Config,
    *,
    client_factory: Callable[..., Any] | None = None,
) -> Any:
    if not config.api_key:
        raise ValueError("API key is required to create a model client")
    if client_factory is None:
        from openai import OpenAI

        client_factory = OpenAI

    options: dict[str, Any] = {"api_key": config.api_key}
    if config.base_url:
        options["base_url"] = config.base_url
    return client_factory(**options)
